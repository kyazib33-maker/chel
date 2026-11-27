//! Claude Code's bidirectional stream-json host adapter.
//! Uses the user's existing Claude Code CLI authentication and stdio protocol.
use permission_engine::{
    ActionClass, ApprovalStatus, PermissionEngine, PermissionError, PermissionRequest,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Duration};
use thiserror::Error;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin},
    sync::{broadcast, Mutex},
    time::timeout,
};
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum ClaudeError {
    #[error("diretório de trabalho inválido: {0}")]
    InvalidCwd(String),
    #[error("não foi possível iniciar Claude Code: {0}")]
    Spawn(#[from] std::io::Error),
    #[error("sessão Claude Code não encontrada")]
    SessionNotFound,
    #[error("Claude Code encerrou a conexão")]
    Disconnected,
    #[error("resposta da sessão expirou")]
    Timeout,
    #[error("mensagem JSON inválida: {0}")]
    Protocol(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeStartRequest {
    pub cwd: PathBuf,
    pub prompt: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
    pub resume_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeSessionInfo {
    pub id: Uuid,
    pub claude_session_id: Option<String>,
    pub cwd: PathBuf,
    pub model: Option<String>,
    pub status: String,
    pub started_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeEvent {
    pub session_id: Uuid,
    pub event_type: String,
    pub payload: Value,
}

struct Session {
    info: Mutex<ClaudeSessionInfo>,
    stdin: Arc<Mutex<ChildStdin>>,
    child: Mutex<Child>,
}

#[derive(Clone)]
pub struct ClaudeCodeManager {
    sessions: Arc<Mutex<HashMap<Uuid, Arc<Session>>>>,
    events: broadcast::Sender<ClaudeEvent>,
}

impl Default for ClaudeCodeManager {
    fn default() -> Self {
        Self::new(512)
    }
}

impl ClaudeCodeManager {
    pub fn new(capacity: usize) -> Self {
        let (events, _) = broadcast::channel(capacity.max(64));
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            events,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ClaudeEvent> {
        self.events.subscribe()
    }

    pub async fn start(
        &self,
        request: ClaudeStartRequest,
    ) -> Result<ClaudeSessionInfo, ClaudeError> {
        if !request.cwd.is_absolute() || !request.cwd.is_dir() {
            return Err(ClaudeError::InvalidCwd(request.cwd.display().to_string()));
        }
        if request.prompt.trim().is_empty() {
            return Err(ClaudeError::Protocol("prompt vazio".into()));
        }
        let mode = request.permission_mode.as_deref().unwrap_or("default");
        if !["default", "acceptEdits", "plan", "auto", "dontAsk"].contains(&mode) {
            return Err(ClaudeError::Protocol(
                "permission_mode inválido; bypassPermissions não é habilitado por este adapter"
                    .into(),
            ));
        }
        let mut args = vec![
            "-p".to_string(),
            "--input-format".into(),
            "stream-json".into(),
            "--output-format".into(),
            "stream-json".into(),
            "--verbose".into(),
            "--include-partial-messages".into(),
            "--permission-prompt-tool".into(),
            "stdio".into(),
            "--permission-mode".into(),
            mode.into(),
        ];
        if let Some(model) = request.model.as_ref() {
            args.extend(["--model".into(), model.clone()]);
        }
        if let Some(effort) = request.effort.as_ref() {
            if !["low", "medium", "high", "max"].contains(&effort.as_str()) {
                return Err(ClaudeError::Protocol("effort inválido".into()));
            }
            args.extend(["--effort".into(), effort.clone()]);
        }
        if let Some(resume) = request.resume_session_id.as_ref() {
            args.extend(["--resume".into(), resume.clone()]);
        }
        let mut command = process_manager::build_cli_command("claude", &args, &request.cwd);
        command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let mut child = command.spawn()?;
        let stdin = child.stdin.take().ok_or(ClaudeError::Disconnected)?;
        let stdout = child.stdout.take().ok_or(ClaudeError::Disconnected)?;
        let stderr = child.stderr.take().ok_or(ClaudeError::Disconnected)?;
        let id = Uuid::new_v4();
        let session = Arc::new(Session {
            info: Mutex::new(ClaudeSessionInfo {
                id,
                claude_session_id: request.resume_session_id,
                cwd: request.cwd,
                model: request.model,
                status: "starting".into(),
                started_at: chrono::Utc::now(),
            }),
            stdin: Arc::new(Mutex::new(stdin)),
            child: Mutex::new(child),
        });
        self.sessions.lock().await.insert(id, session.clone());
        let events = self.events.clone();
        let session_reader = session.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    let _ = events.send(ClaudeEvent {
                        session_id: id,
                        event_type: "protocol/unparsed".into(),
                        payload: json!({"line": line.chars().take(2000).collect::<String>()}),
                    });
                    continue;
                };
                let event_type = message
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string();
                if event_type == "system"
                    && message.get("subtype").and_then(Value::as_str) == Some("init")
                {
                    let mut info = session_reader.info.lock().await;
                    info.claude_session_id = message
                        .get("session_id")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    info.status = "running".into();
                } else if event_type == "result" {
                    session_reader.info.lock().await.status = "idle".into();
                }
                let _ = events.send(ClaudeEvent {
                    session_id: id,
                    event_type,
                    payload: message,
                });
            }
            session_reader.info.lock().await.status = "disconnected".into();
            let _ = events.send(ClaudeEvent {
                session_id: id,
                event_type: "transport/closed".into(),
                payload: Value::Null,
            });
        });
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!(target: "claude_code", "{line}");
            }
        });
        self.send_user_message(id, request.prompt).await?;
        let info = session.info.lock().await.clone();
        Ok(info)
    }

    pub async fn send_user_message(&self, id: Uuid, prompt: String) -> Result<(), ClaudeError> {
        if prompt.trim().is_empty() {
            return Err(ClaudeError::Protocol("mensagem vazia".into()));
        }
        let session = self.get(id).await?;
        let message = json!({"type":"user","message":{"role":"user","content":prompt}});
        self.write(&session, message).await
    }

    pub async fn respond_control_error(
        &self,
        id: Uuid,
        request_id: String,
        error: String,
    ) -> Result<(), ClaudeError> {
        let session = self.get(id).await?;
        self.write(&session, json!({"type":"control_response","response":{"subtype":"error","request_id":request_id,"error":error}})).await
    }

    pub async fn respond_permission(
        &self,
        id: Uuid,
        request_id: String,
        allow: bool,
        updated_input: Option<Value>,
        message: Option<String>,
    ) -> Result<(), ClaudeError> {
        let session = self.get(id).await?;
        let response = if allow {
            json!({"behavior":"allow","updatedInput":updated_input.unwrap_or(Value::Null)})
        } else {
            json!({"behavior":"deny","message":message.unwrap_or_else(|| "Negado pelo usuário no Chel".into())})
        };
        self.write(&session, json!({"type":"control_response","response":{"subtype":"success","request_id":request_id,"response":response}})).await
    }

    async fn write(&self, session: &Arc<Session>, value: Value) -> Result<(), ClaudeError> {
        let mut stdin = session.stdin.lock().await;
        let mut line =
            serde_json::to_vec(&value).map_err(|error| ClaudeError::Protocol(error.to_string()))?;
        line.push(b'\n');
        timeout(Duration::from_secs(10), async {
            stdin.write_all(&line).await?;
            stdin.flush().await
        })
        .await
        .map_err(|_| ClaudeError::Timeout)??;
        Ok(())
    }

    async fn get(&self, id: Uuid) -> Result<Arc<Session>, ClaudeError> {
        self.sessions
            .lock()
            .await
            .get(&id)
            .cloned()
            .ok_or(ClaudeError::SessionNotFound)
    }

    pub async fn list(&self) -> Vec<ClaudeSessionInfo> {
        let sessions = self
            .sessions
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut result = Vec::with_capacity(sessions.len());
        for session in sessions {
            result.push(session.info.lock().await.clone());
        }
        result.sort_by_key(|a| std::cmp::Reverse(a.started_at));
        result
    }

    pub async fn stop(&self, id: Uuid) -> Result<(), ClaudeError> {
        let session = self
            .sessions
            .lock()
            .await
            .remove(&id)
            .ok_or(ClaudeError::SessionNotFound)?;
        let mut child = session.child.lock().await;
        process_manager::terminate_cli_process_tree(&mut child).await;
        Ok(())
    }
}

type PendingClaudeApprovals = Arc<Mutex<HashMap<Uuid, (Uuid, String, Value)>>>;

#[derive(Clone)]
pub struct ClaudeApprovalBridge {
    manager: ClaudeCodeManager,
    permissions: PermissionEngine,
    pending: PendingClaudeApprovals,
}

impl ClaudeApprovalBridge {
    pub fn new(manager: ClaudeCodeManager, permissions: PermissionEngine) -> Self {
        Self {
            manager,
            permissions,
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn run(&self) {
        let mut events = self.manager.subscribe();
        loop {
            match events.recv().await {
                Ok(event) => {
                    if let Err(error) = self.capture(event).await {
                        tracing::warn!(%error, "Claude permission request handling failed");
                    }
                }
                Err(broadcast::error::RecvError::Lagged(count)) => {
                    tracing::warn!(count, "Claude event stream lagged")
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    }

    async fn capture(&self, event: ClaudeEvent) -> Result<(), PermissionError> {
        if event.event_type == "transport/closed" {
            let mut pending = self.pending.lock().await;
            let ids = pending
                .iter()
                .filter_map(|(id, (session, _, _))| (*session == event.session_id).then_some(*id))
                .collect::<Vec<_>>();
            for id in ids {
                pending.remove(&id);
                let _ = self
                    .permissions
                    .expire(id, "claude:disconnected".into())
                    .await;
            }
            return Ok(());
        }
        if event.event_type != "control_request" {
            return Ok(());
        }
        let Some(request_id) = event
            .payload
            .get("request_id")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            return Ok(());
        };
        let subtype = event
            .payload
            .pointer("/request/subtype")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        if subtype != "can_use_tool" {
            self.manager
                .respond_control_error(
                    event.session_id,
                    request_id,
                    format!(
                        "Chel não implementa o control request '{subtype}' nesta versão"
                    ),
                )
                .await
                .map_err(|_| PermissionError::NotPending)?;
            return Ok(());
        }
        let request = &event.payload["request"];
        let tool = request
            .get("tool_name")
            .and_then(Value::as_str)
            .unwrap_or("unknown_tool");
        let input = request.get("input").cloned().unwrap_or(Value::Null);
        let action = classify_claude_tool(tool, &input);
        match self.permissions.evaluate(action).decision {
            permission_engine::PermissionDecision::Allow => {
                self.manager
                    .respond_permission(
                        event.session_id,
                        request_id,
                        true,
                        Some(input.clone()),
                        None,
                    )
                    .await
                    .map_err(|_| PermissionError::NotPending)?;
                return Ok(());
            }
            permission_engine::PermissionDecision::Deny => {
                self.manager
                    .respond_permission(
                        event.session_id,
                        request_id,
                        false,
                        None,
                        Some("Bloqueado pela política do Chel".into()),
                    )
                    .await
                    .map_err(|_| PermissionError::NotPending)?;
                return Ok(());
            }
            permission_engine::PermissionDecision::RequireApproval => {}
        }
        let preview = serde_json::to_string_pretty(&input).unwrap_or_else(|_| input.to_string());
        let summary = format!("Claude Code solicitou permissão para {tool}.");
        let approval = match self
            .permissions
            .submit(
                event.session_id,
                "claude_code",
                tool,
                action,
                summary,
                preview,
            )
            .await
        {
            Ok(value) => value,
            Err(error) => {
                let _ = self
                    .manager
                    .respond_permission(
                        event.session_id,
                        request_id,
                        false,
                        None,
                        Some("Fila de aprovações indisponível".into()),
                    )
                    .await;
                return Err(error);
            }
        };
        self.pending
            .lock()
            .await
            .insert(approval.id, (event.session_id, request_id, input));
        Ok(())
    }

    pub async fn list(&self) -> Vec<PermissionRequest> {
        let all = self.permissions.list().await;
        let pending_ids = all
            .iter()
            .filter(|item| item.status == ApprovalStatus::Pending)
            .map(|item| item.id)
            .collect::<std::collections::HashSet<_>>();
        let mut pending = self.pending.lock().await;
        let stale = pending
            .keys()
            .filter_map(|id| (!pending_ids.contains(id)).then_some(*id))
            .collect::<Vec<_>>();
        for id in stale {
            if let Some((session, request, _)) = pending.remove(&id) {
                let _ = self
                    .manager
                    .respond_permission(
                        session,
                        request,
                        false,
                        None,
                        Some("Solicitação expirada".into()),
                    )
                    .await;
            }
        }
        all.into_iter()
            .filter(|item| item.provider == "claude_code")
            .collect()
    }

    pub async fn decide(
        &self,
        id: Uuid,
        approve: bool,
        actor: String,
    ) -> Result<PermissionRequest, PermissionError> {
        let target = self.pending.lock().await.get(&id).cloned();
        if let Some((session, request_id, input)) = target {
            // Commit the policy decision atomically first: an expired request can
            // never be turned into an allow by racing the native response write.
            let result = self.permissions.decide(id, approve, actor).await?;
            let response = self
                .manager
                .respond_permission(
                    session,
                    request_id,
                    approve,
                    if approve { Some(input) } else { None },
                    if approve {
                        None
                    } else {
                        Some("Negado pelo usuário no Chel".into())
                    },
                )
                .await;
            self.pending.lock().await.remove(&id);
            response.map_err(|_| PermissionError::NotPending)?;
            return Ok(result);
        }
        Err(PermissionError::NotFound)
    }
}

fn classify_claude_tool(tool: &str, input: &Value) -> ActionClass {
    let name = tool.to_ascii_lowercase();
    if name.contains("bash") || name.contains("command") {
        let command = input
            .get("command")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        if [
            "rm ",
            "rmdir",
            "del ",
            "format ",
            "shutdown",
            "diskpart",
            "git push --force",
        ]
        .iter()
        .any(|needle| command.contains(needle))
        {
            ActionClass::Destructive
        } else {
            ActionClass::Execute
        }
    } else if name.contains("write") || name.contains("edit") || name.contains("notebook") {
        ActionClass::Write
    } else if name.contains("web") || name.contains("fetch") || name.contains("search") {
        ActionClass::Network
    } else if name.contains("read") || name.contains("glob") || name.contains("grep") {
        ActionClass::Read
    } else {
        ActionClass::Write
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn classifies_tools_conservatively() {
        assert_eq!(
            classify_claude_tool("Read", &Value::Null),
            ActionClass::Read
        );
        assert_eq!(
            classify_claude_tool("Edit", &Value::Null),
            ActionClass::Write
        );
        assert_eq!(
            classify_claude_tool("Bash", &json!({"command":"rm -rf ./tmp"})),
            ActionClass::Destructive
        );
        assert_eq!(
            classify_claude_tool("MCP_custom", &Value::Null),
            ActionClass::Write
        );
    }
}
