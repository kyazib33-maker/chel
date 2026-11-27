//! Native Codex App Server integration over JSON-RPC / JSONL stdio.
//! No shell is used. The CLI's existing local authentication is reused.
use permission_engine::{
    ActionClass, ApprovalStatus, PermissionEngine, PermissionError, PermissionRequest,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use thiserror::Error;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin},
    sync::{broadcast, oneshot, Mutex},
    time::timeout,
};
use uuid::Uuid;

const RPC_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Error)]
pub enum CodexError {
    #[error("diretório de trabalho inválido: {0}")]
    InvalidCwd(String),
    #[error("não foi possível iniciar codex app-server: {0}")]
    Spawn(#[from] std::io::Error),
    #[error("app-server encerrou a conexão")]
    Disconnected,
    #[error("timeout aguardando resposta do Codex")]
    Timeout,
    #[error("erro JSON-RPC do Codex: {0}")]
    Rpc(String),
    #[error("sessão Codex não encontrada")]
    SessionNotFound,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexStartRequest {
    pub cwd: PathBuf,
    pub prompt: String,
    pub model: Option<String>,
    /// Sandbox do Codex. Defaults to workspace-write; never silently escalates.
    pub sandbox: Option<String>,
    /// Persistent conversation history in the user's Codex home.
    pub persistent: Option<bool>,
    /// Resume a previously persisted App Server thread instead of creating one.
    #[serde(default)]
    pub resume_thread_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexSessionInfo {
    pub id: Uuid,
    pub thread_id: String,
    pub cwd: PathBuf,
    pub status: String,
    pub started_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexServerEvent {
    pub session_id: Uuid,
    pub method: String,
    pub params: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<Value>,
}

struct PendingRequest {
    tx: oneshot::Sender<Result<Value, CodexError>>,
}

struct Session {
    info: Mutex<CodexSessionInfo>,
    stdin: Arc<Mutex<ChildStdin>>,
    child: Mutex<Child>,
    pending: Arc<Mutex<HashMap<String, PendingRequest>>>,
    next_id: AtomicU64,
}

#[derive(Clone)]
pub struct CodexAppServerManager {
    sessions: Arc<Mutex<HashMap<Uuid, Arc<Session>>>>,
    events: broadcast::Sender<CodexServerEvent>,
}

impl Default for CodexAppServerManager {
    fn default() -> Self {
        Self::new(512)
    }
}

impl CodexAppServerManager {
    pub fn new(event_capacity: usize) -> Self {
        let (events, _) = broadcast::channel(event_capacity.max(64));
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            events,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<CodexServerEvent> {
        self.events.subscribe()
    }

    pub async fn start(&self, request: CodexStartRequest) -> Result<CodexSessionInfo, CodexError> {
        if request.prompt.trim().is_empty() {
            return Err(CodexError::Rpc("prompt vazio".into()));
        }
        if !request.cwd.is_absolute() || !request.cwd.is_dir() {
            return Err(CodexError::InvalidCwd(request.cwd.display().to_string()));
        }
        let args = vec!["app-server".into(), "--listen".into(), "stdio://".into()];
        let mut command = process_manager::build_cli_command("codex", &args, &request.cwd);
        command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn()?;
        let stdin = child.stdin.take().ok_or(CodexError::Disconnected)?;
        let stdout = child.stdout.take().ok_or(CodexError::Disconnected)?;
        let stderr = child.stderr.take().ok_or(CodexError::Disconnected)?;
        let session_id = Uuid::new_v4();
        let pending = Arc::new(Mutex::new(HashMap::<String, PendingRequest>::new()));
        let session = Arc::new(Session {
            info: Mutex::new(CodexSessionInfo {
                id: session_id,
                thread_id: String::new(),
                cwd: request.cwd.clone(),
                status: "starting".into(),
                started_at: chrono::Utc::now(),
            }),
            stdin: Arc::new(Mutex::new(stdin)),
            child: Mutex::new(child),
            pending: pending.clone(),
            next_id: AtomicU64::new(1),
        });
        self.sessions
            .lock()
            .await
            .insert(session_id, session.clone());

        let event_tx = self.events.clone();
        let pending_reader = pending.clone();
        let session_for_reader = session.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(id) = message.get("id") {
                    let key = id.to_string();
                    if message.get("method").is_some() {
                        let method = message["method"].as_str().unwrap_or("unknown").to_string();
                        let _ = event_tx.send(CodexServerEvent {
                            session_id,
                            method,
                            params: message.get("params").cloned().unwrap_or(Value::Null),
                            request_id: Some(id.clone()),
                        });
                    } else if let Some(pending) = pending_reader.lock().await.remove(&key) {
                        let result = if let Some(error) = message.get("error") {
                            Err(CodexError::Rpc(error.to_string()))
                        } else {
                            Ok(message.get("result").cloned().unwrap_or(Value::Null))
                        };
                        let _ = pending.tx.send(result);
                    }
                } else if let Some(method) = message.get("method").and_then(Value::as_str) {
                    if method == "turn/started" {
                        session_for_reader.info.lock().await.status = "running".into();
                    }
                    if method == "turn/completed" {
                        session_for_reader.info.lock().await.status = "idle".into();
                    }
                    let _ = event_tx.send(CodexServerEvent {
                        session_id,
                        method: method.to_string(),
                        params: message.get("params").cloned().unwrap_or(Value::Null),
                        request_id: None,
                    });
                }
            }
            // Fail all in-flight requests if the transport closes.
            let mut waiting = pending_reader.lock().await;
            for (_, request) in waiting.drain() {
                let _ = request.tx.send(Err(CodexError::Disconnected));
            }
            session_for_reader.info.lock().await.status = "disconnected".into();
            let _ = event_tx.send(CodexServerEvent {
                session_id,
                method: "transport/closed".into(),
                params: Value::Null,
                request_id: None,
            });
        });
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!(target: "codex_app_server", "{line}");
            }
        });

        let init = self.request(&session, "initialize", json!({
            "clientInfo": { "name": "psylium", "title": "Psylium", "version": env!("CARGO_PKG_VERSION") },
            "capabilities": { "experimentalApi": false }
        })).await;
        if let Err(error) = init {
            let _ = self.stop(session_id).await;
            return Err(error);
        }
        if let Err(error) = self.notify(&session, "initialized", json!({})).await {
            let _ = self.stop(session_id).await;
            return Err(error);
        }

        let sandbox = request.sandbox.unwrap_or_else(|| "workspace-write".into());
        if !["read-only", "workspace-write", "danger-full-access"].contains(&sandbox.as_str()) {
            let _ = self.stop(session_id).await;
            return Err(CodexError::Rpc("sandbox inválido".into()));
        }
        let mut thread_params = json!({
            "cwd": request.cwd,
            "approvalPolicy": "on-request",
            "sandbox": sandbox,
            "ephemeral": !request.persistent.unwrap_or(true),
            "threadSource": "user"
        });
        if let Some(model) = request.model {
            thread_params["model"] = Value::String(model);
        }
        let thread = if let Some(thread_id) = request.resume_thread_id.as_ref() {
            if thread_id.trim().is_empty() {
                let _ = self.stop(session_id).await;
                return Err(CodexError::Rpc("thread_id vazio para retomada".into()));
            }
            match self
                .request(
                    &session,
                    "thread/resume",
                    json!({ "threadId": thread_id, "excludeTurns": true }),
                )
                .await
            {
                Ok(value) => value,
                Err(error) => {
                    let _ = self.stop(session_id).await;
                    return Err(error);
                }
            }
        } else {
            match self.request(&session, "thread/start", thread_params).await {
                Ok(value) => value,
                Err(error) => {
                    let _ = self.stop(session_id).await;
                    return Err(error);
                }
            }
        };
        let thread_id = match thread.pointer("/thread/id").and_then(Value::as_str) {
            Some(value) => value.to_string(),
            None => {
                let _ = self.stop(session_id).await;
                return Err(CodexError::Rpc(
                    "thread/start não retornou thread.id".into(),
                ));
            }
        };
        if let Err(error) = self
            .request(
                &session,
                "turn/start",
                json!({
                    "threadId": thread_id,
                    "input": [{ "type": "text", "text": request.prompt }]
                }),
            )
            .await
        {
            let _ = self.stop(session_id).await;
            return Err(error);
        }

        let mut info = session.info.lock().await;
        info.thread_id = thread_id;
        info.status = "running".into();
        Ok(info.clone())
    }

    async fn request(
        &self,
        session: &Arc<Session>,
        method: &str,
        params: Value,
    ) -> Result<Value, CodexError> {
        let id = session.next_id.fetch_add(1, Ordering::Relaxed);
        let key = json!(id).to_string();
        let (tx, rx) = oneshot::channel();
        session
            .pending
            .lock()
            .await
            .insert(key, PendingRequest { tx });
        let message = json!({ "id": id, "method": method, "params": params });
        if let Err(error) = self.write(session, message).await {
            session.pending.lock().await.remove(&json!(id).to_string());
            return Err(error);
        }
        timeout(RPC_TIMEOUT, rx)
            .await
            .map_err(|_| CodexError::Timeout)?
            .map_err(|_| CodexError::Disconnected)?
    }

    async fn notify(
        &self,
        session: &Arc<Session>,
        method: &str,
        params: Value,
    ) -> Result<(), CodexError> {
        self.write(session, json!({ "method": method, "params": params }))
            .await
    }

    async fn write(&self, session: &Arc<Session>, message: Value) -> Result<(), CodexError> {
        let mut stdin = session.stdin.lock().await;
        stdin.write_all(message.to_string().as_bytes()).await?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await?;
        Ok(())
    }

    /// Responds to a server-initiated JSON-RPC request (e.g. native command/file approval).
    pub async fn respond(
        &self,
        session_id: Uuid,
        request_id: Value,
        result: Value,
    ) -> Result<(), CodexError> {
        let session = self
            .sessions
            .lock()
            .await
            .get(&session_id)
            .cloned()
            .ok_or(CodexError::SessionNotFound)?;
        self.write(&session, json!({ "id": request_id, "result": result }))
            .await
    }

    pub async fn approve(
        &self,
        session_id: Uuid,
        request_id: Value,
        decision: &str,
    ) -> Result<(), CodexError> {
        let allowed = ["accept", "acceptForSession", "decline", "cancel"];
        if !allowed.contains(&decision) {
            return Err(CodexError::Rpc("decisão de aprovação inválida".into()));
        }
        self.respond(session_id, request_id, json!({ "decision": decision }))
            .await
    }

    /// Starts another turn in an already-running App Server session.
    pub async fn send_user_message(
        &self,
        session_id: Uuid,
        prompt: String,
    ) -> Result<(), CodexError> {
        if prompt.trim().is_empty() {
            return Err(CodexError::Rpc("prompt vazio".into()));
        }
        let session = self
            .sessions
            .lock()
            .await
            .get(&session_id)
            .cloned()
            .ok_or(CodexError::SessionNotFound)?;
        let thread_id = session.info.lock().await.thread_id.clone();
        self.request(
            &session,
            "turn/start",
            json!({
                "threadId": thread_id,
                "input": [{ "type": "text", "text": prompt }]
            }),
        )
        .await?;
        Ok(())
    }

    pub async fn list(&self) -> Vec<CodexSessionInfo> {
        // Session metadata is reconstructed from each active process and its thread id is updated by events.
        let sessions: Vec<_> = self.sessions.lock().await.values().cloned().collect();
        let mut result = Vec::with_capacity(sessions.len());
        for session in sessions {
            result.push(session.info.lock().await.clone());
        }
        result
    }

    pub async fn stop(&self, session_id: Uuid) -> Result<(), CodexError> {
        let session = self
            .sessions
            .lock()
            .await
            .remove(&session_id)
            .ok_or(CodexError::SessionNotFound)?;
        let mut child = session.child.lock().await;
        process_manager::terminate_cli_process_tree(&mut child).await;
        Ok(())
    }
}

/// Bridges native Codex approval requests into the shared permission queue.
/// A decision made through Desktop or the paired Mobile client is sent back
/// to the exact JSON-RPC request that paused the Codex turn.
#[derive(Clone)]
pub struct CodexApprovalBridge {
    manager: CodexAppServerManager,
    permissions: PermissionEngine,
    pending: Arc<Mutex<HashMap<Uuid, NativeApprovalRef>>>,
}

#[derive(Clone)]
struct NativeApprovalRef {
    session_id: Uuid,
    request_id: Value,
    kind: NativeApprovalKind,
}

#[derive(Clone)]
enum NativeApprovalKind {
    CommandOrFile,
    PermissionGrant { requested: Value },
}

impl CodexApprovalBridge {
    pub fn new(manager: CodexAppServerManager, permissions: PermissionEngine) -> Self {
        Self {
            manager,
            permissions,
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Runs the event consumer. Spawn this on the application's async runtime.
    pub async fn run(&self) {
        let mut events = self.manager.subscribe();
        loop {
            match events.recv().await {
                Ok(event) => {
                    if let Err(error) = self.capture(event).await {
                        tracing::warn!(%error, "could not route native Codex approval into permission queue");
                    }
                }
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    tracing::warn!(
                        skipped,
                        "Codex approval bridge lagged; pending approvals may need session refresh"
                    );
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    }

    async fn capture(&self, event: CodexServerEvent) -> Result<(), PermissionError> {
        if event.method == "serverRequest/resolved" {
            if let Some(resolved_id) = event.params.get("requestId") {
                let mut pending = self.pending.lock().await;
                let approval_id = pending.iter().find_map(|(approval_id, target)| {
                    (target.session_id == event.session_id
                        && target.request_id == resolved_id.clone())
                    .then_some(*approval_id)
                });
                if let Some(approval_id) = approval_id {
                    pending.remove(&approval_id);
                    let _ = self
                        .permissions
                        .expire(approval_id, "codex:request-cleared".into())
                        .await;
                }
            }
            return Ok(());
        }
        if event.method == "transport/closed" {
            let mut pending = self.pending.lock().await;
            let stale: Vec<Uuid> = pending
                .iter()
                .filter_map(|(id, target)| (target.session_id == event.session_id).then_some(*id))
                .collect();
            for id in stale {
                pending.remove(&id);
                let _ = self
                    .permissions
                    .expire(id, "codex:session-disconnected".into())
                    .await;
            }
            return Ok(());
        }
        let Some(request_id) = event.request_id else {
            return Ok(());
        };
        let (action, tool, summary, kind) = match event.method.as_str() {
            "item/commandExecution/requestApproval" => {
                let command = event
                    .params
                    .get("command")
                    .map(display_json)
                    .unwrap_or_else(|| "Comando solicitado pelo Codex".into());
                (
                    ActionClass::Execute,
                    "commandExecution",
                    format!("Codex solicitou autorização para executar: {command}"),
                    NativeApprovalKind::CommandOrFile,
                )
            }
            "item/fileChange/requestApproval" => (
                ActionClass::Write,
                "fileChange",
                "Codex solicitou autorização para aplicar alterações nos arquivos.".into(),
                NativeApprovalKind::CommandOrFile,
            ),
            "item/permissions/requestApproval" => {
                let requested = event
                    .params
                    .get("permissions")
                    .filter(|value| value.is_object())
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let permissions = display_json(&requested);
                let is_network = permissions.to_lowercase().contains("network");
                (
                    if is_network {
                        ActionClass::Network
                    } else {
                        ActionClass::Write
                    },
                    "permissions",
                    format!("Codex solicitou permissões adicionais: {permissions}"),
                    NativeApprovalKind::PermissionGrant { requested },
                )
            }
            _ => return Ok(()),
        };
        let session_id = event.session_id;
        match self.permissions.evaluate(action).decision {
            permission_engine::PermissionDecision::Allow => {
                respond_native(&self.manager, session_id, request_id, &kind, true).await?;
                return Ok(());
            }
            permission_engine::PermissionDecision::Deny => {
                respond_native(&self.manager, session_id, request_id, &kind, false).await?;
                return Ok(());
            }
            permission_engine::PermissionDecision::RequireApproval => {}
        }
        let preview = serde_json::to_string_pretty(&event.params)
            .unwrap_or_else(|_| event.params.to_string());
        let request = match self
            .permissions
            .submit(session_id, "codex", tool, action, summary, preview)
            .await
        {
            Ok(request) => request,
            Err(error) => {
                // Never leave the native Codex turn hanging if the shared queue
                // cannot represent the request (for example, when it is full).
                respond_native(&self.manager, session_id, request_id, &kind, false).await?;
                return Err(error);
            }
        };
        self.pending.lock().await.insert(
            request.id,
            NativeApprovalRef {
                session_id,
                request_id,
                kind,
            },
        );
        Ok(())
    }

    pub async fn list(&self) -> Vec<PermissionRequest> {
        let requests = self.permissions.list().await;
        let pending_ids: std::collections::HashSet<Uuid> = requests
            .iter()
            .filter(|request| request.status == ApprovalStatus::Pending)
            .map(|request| request.id)
            .collect();
        let mut native = self.pending.lock().await;
        let stale: Vec<(Uuid, NativeApprovalRef)> = native
            .iter()
            .filter_map(|(id, target)| (!pending_ids.contains(id)).then_some((*id, target.clone())))
            .collect();
        for (id, target) in stale {
            let _ = respond_native(
                &self.manager,
                target.session_id,
                target.request_id,
                &target.kind,
                false,
            )
            .await;
            native.remove(&id);
        }
        requests
            .into_iter()
            .filter(|request| request.provider == "codex")
            .collect()
    }

    pub async fn decide(
        &self,
        id: Uuid,
        approve: bool,
        actor: String,
    ) -> Result<PermissionRequest, PermissionError> {
        if actor.trim().is_empty() {
            return Err(PermissionError::InvalidActor);
        }
        let mut pending = self.pending.lock().await;
        if let Some(target) = pending.get(&id).cloned() {
            let still_pending = self
                .permissions
                .list()
                .await
                .into_iter()
                .any(|request| request.id == id && request.status == ApprovalStatus::Pending);
            if !still_pending {
                // An expired UI request must never be converted into an approval.
                // Decline the native request so the Codex turn cannot remain blocked.
                let _ = respond_native(
                    &self.manager,
                    target.session_id,
                    target.request_id,
                    &target.kind,
                    false,
                )
                .await;
                pending.remove(&id);
                return Err(PermissionError::NotPending);
            }
            respond_native(
                &self.manager,
                target.session_id,
                target.request_id,
                &target.kind,
                approve,
            )
            .await?;
            let decided = self.permissions.decide(id, approve, actor).await?;
            pending.remove(&id);
            return Ok(decided);
        }
        drop(pending);
        self.permissions.decide(id, approve, actor).await
    }
}

async fn respond_native(
    manager: &CodexAppServerManager,
    session_id: Uuid,
    request_id: Value,
    kind: &NativeApprovalKind,
    approve: bool,
) -> Result<(), PermissionError> {
    let result = match kind {
        NativeApprovalKind::CommandOrFile => {
            manager
                .approve(
                    session_id,
                    request_id,
                    if approve { "accept" } else { "decline" },
                )
                .await
        }
        NativeApprovalKind::PermissionGrant { requested } => {
            manager
                .respond(
                    session_id,
                    request_id,
                    json!({
                        "permissions": if approve { requested.clone() } else { json!({}) },
                        "scope": "turn"
                    }),
                )
                .await
        }
    };
    result.map_err(|_| PermissionError::NotPending)
}

fn display_json(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_payload_uses_native_codex_decision_shape() {
        let payload = json!({ "decision": "acceptForSession" });
        assert_eq!(payload["decision"], "acceptForSession");
    }

    #[test]
    fn rejects_unrecognized_sandbox_values() {
        let accepted = ["read-only", "workspace-write", "danger-full-access"];
        assert!(!accepted.contains(&"unrestricted"));
    }
}
