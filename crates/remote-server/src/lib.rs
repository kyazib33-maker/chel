use antigravity_adapter::{
    build_process_spec as build_antigravity_spec, default_cache_path, read_workspace_conversation,
    AntigravityRequest,
};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::{header::AUTHORIZATION, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use claude_code_adapter::{ClaudeApprovalBridge, ClaudeCodeManager, ClaudeStartRequest};
use codex_app_server::{CodexAppServerManager, CodexApprovalBridge, CodexStartRequest};
use futures_util::StreamExt;
use permission_engine::PermissionRequest;
use process_manager::ProcessManager;
use provider_adapters::build_process_spec;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use session_manager::{ManagedSession, SessionRegistry};
use session_manager::{RecoveryMode, SessionProvider};
use sha2::{Digest, Sha256};
use shared_protocol::{AgentLaunchRequest, TaskEvent, TaskEventPayload, TaskId, TaskSnapshot};
use std::{
    collections::VecDeque,
    net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket},
    path::{Path as FsPath, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use thiserror::Error;
use tokio::{
    net::TcpListener,
    sync::{broadcast, Mutex as AsyncMutex},
    task::JoinHandle,
    time::timeout,
};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};
use usage_monitor::{UsageMonitor, UsageSnapshot};
use uuid::Uuid;
use workflow_engine::{WorkflowDefinition, WorkflowStore};
use workflow_runner::{
    WorkflowCheckpoint, WorkflowCheckpointStore, WorkflowProgressEvent, WorkflowRunPolicy,
    WorkflowRunRequest, WorkflowRunResult, WorkflowRunStore, WorkflowRunner,
};

const DEFAULT_PORT: u16 = 17_891;
const PAIRING_TTL_SECONDS: i64 = 180;
const EVENT_JOURNAL_CAPACITY: usize = 4_096;
const WS_AUTH_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_WS_FRAME_BYTES: usize = 64 * 1024;

#[derive(Debug, Error)]
pub enum RemoteServerError {
    #[error("não foi possível inicializar o banco de dispositivos: {0}")]
    Database(String),
    #[error("não foi possível iniciar o servidor remoto: {0}")]
    Bind(String),
    #[error("servidor remoto ainda não está iniciado")]
    NotRunning,
    #[error("servidor remoto já está iniciado")]
    AlreadyRunning,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteServerInfo {
    pub running: bool,
    pub port: u16,
    pub lan_enabled: bool,
    pub endpoints: Vec<String>,
    pub security_notice: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PairingInfo {
    pub version: u8,
    pub endpoints: Vec<String>,
    pub pairing_code: String,
    pub expires_at: DateTime<Utc>,
    /// Compact JSON to be rendered as a QR by the Desktop UI.
    pub qr_payload: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PairedDevice {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub last_seen_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PairResponse {
    pub device_id: String,
    pub device_token: String,
    pub server_time: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct RemoteServerConfig {
    pub enable_lan: bool,
    pub port: u16,
    pub allowed_root: PathBuf,
}

impl Default for RemoteServerConfig {
    fn default() -> Self {
        Self {
            enable_lan: false,
            port: DEFAULT_PORT,
            allowed_root: std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(".")),
        }
    }
}

#[derive(Clone)]
pub struct RemoteServerController {
    processes: ProcessManager,
    usage: UsageMonitor,
    workflows: WorkflowStore,
    workflow_runner: WorkflowRunner,
    workflow_history: WorkflowRunStore,
    approvals: CodexApprovalBridge,
    claude_approvals: ClaudeApprovalBridge,
    claude_manager: ClaudeCodeManager,
    codex_manager: CodexAppServerManager,
    sessions: SessionRegistry,
    db_path: PathBuf,
    allowed_root: PathBuf,
    active: Arc<AsyncMutex<Option<RemoteServer>>>,
}

impl RemoteServerController {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        processes: ProcessManager,
        usage: UsageMonitor,
        workflows: WorkflowStore,
        workflow_runner: WorkflowRunner,
        workflow_history: WorkflowRunStore,
        approvals: CodexApprovalBridge,
        claude_approvals: ClaudeApprovalBridge,
        claude_manager: ClaudeCodeManager,
        codex_manager: CodexAppServerManager,
        sessions: SessionRegistry,
        db_path: PathBuf,
        allowed_root: PathBuf,
    ) -> Self {
        Self {
            processes,
            usage,
            workflows,
            workflow_runner,
            workflow_history,
            approvals,
            claude_approvals,
            claude_manager,
            codex_manager,
            sessions,
            db_path,
            allowed_root,
            active: Arc::new(AsyncMutex::new(None)),
        }
    }

    pub async fn start(&self, enable_lan: bool) -> Result<RemoteServerInfo, RemoteServerError> {
        let mut active = self.active.lock().await;
        if active.is_some() {
            return Err(RemoteServerError::AlreadyRunning);
        }
        let config = RemoteServerConfig {
            enable_lan,
            port: DEFAULT_PORT,
            allowed_root: self.allowed_root.clone(),
        };
        let server = RemoteServer::start(
            config,
            self.processes.clone(),
            self.usage.clone(),
            self.workflows.clone(),
            self.workflow_runner.clone(),
            self.workflow_history.clone(),
            self.approvals.clone(),
            self.claude_approvals.clone(),
            self.claude_manager.clone(),
            self.codex_manager.clone(),
            self.sessions.clone(),
            self.db_path.clone(),
        )
        .await?;
        let info = server.info();
        *active = Some(server);
        Ok(info)
    }

    pub async fn stop(&self) -> Result<(), RemoteServerError> {
        let mut active = self.active.lock().await;
        let server = active.take().ok_or(RemoteServerError::NotRunning)?;
        server.stop().await;
        Ok(())
    }

    pub async fn info(&self) -> RemoteServerInfo {
        self.active
            .lock()
            .await
            .as_ref()
            .map(RemoteServer::info)
            .unwrap_or(RemoteServerInfo {
                running: false,
                port: DEFAULT_PORT,
                lan_enabled: false,
                endpoints: Vec::new(),
                security_notice:
                    "Servidor desligado. O servidor inicia apenas após ação explícita.".into(),
            })
    }

    pub async fn create_pairing(&self) -> Result<PairingInfo, RemoteServerError> {
        let active = self.active.lock().await;
        let server = active.as_ref().ok_or(RemoteServerError::NotRunning)?;
        server.create_pairing().await
    }

    pub async fn list_devices(&self) -> Result<Vec<PairedDevice>, RemoteServerError> {
        let active = self.active.lock().await;
        let server = active.as_ref().ok_or(RemoteServerError::NotRunning)?;
        server.state.devices.list().await
    }

    pub async fn revoke_device(&self, id: String) -> Result<(), RemoteServerError> {
        let active = self.active.lock().await;
        let server = active.as_ref().ok_or(RemoteServerError::NotRunning)?;
        server.state.devices.revoke(id).await
    }
}

struct RemoteServer {
    info: RemoteServerInfo,
    state: Arc<AppState>,
    shutdown: CancellationToken,
    server_task: JoinHandle<()>,
    forwarder_task: JoinHandle<()>,
}

impl RemoteServer {
    #[allow(clippy::too_many_arguments)]
    async fn start(
        config: RemoteServerConfig,
        processes: ProcessManager,
        usage: UsageMonitor,
        workflows: WorkflowStore,
        workflow_runner: WorkflowRunner,
        workflow_history: WorkflowRunStore,
        approvals: CodexApprovalBridge,
        claude_approvals: ClaudeApprovalBridge,
        claude_manager: ClaudeCodeManager,
        codex_manager: CodexAppServerManager,
        sessions: SessionRegistry,
        db_path: PathBuf,
    ) -> Result<Self, RemoteServerError> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| RemoteServerError::Database(error.to_string()))?;
        }
        let checkpoint_dir = db_path
            .parent()
            .unwrap_or_else(|| FsPath::new("."))
            .join("workflow-checkpoints");
        let devices = DeviceStore::open(db_path)?;
        let mut process_events = processes.subscribe();
        let bind_ip = if config.enable_lan {
            IpAddr::V4(Ipv4Addr::UNSPECIFIED)
        } else {
            IpAddr::V4(Ipv4Addr::LOCALHOST)
        };
        let bind_addr = SocketAddr::new(bind_ip, config.port);
        let listener = TcpListener::bind(bind_addr)
            .await
            .map_err(|error| RemoteServerError::Bind(error.to_string()))?;
        let actual_addr = listener
            .local_addr()
            .map_err(|error| RemoteServerError::Bind(error.to_string()))?;
        let endpoints = advertised_endpoints(config.enable_lan, actual_addr.port()).await;
        let info = RemoteServerInfo {
            running: true,
            port: actual_addr.port(),
            lan_enabled: config.enable_lan,
            endpoints,
            security_notice: if config.enable_lan {
                "Acesso LAN habilitado explicitamente. HTTP não cifra o tráfego; prefira Tailscale em redes não confiáveis e não encaminhe esta porta para a Internet.".into()
            } else {
                "Servidor restrito a localhost; dispositivos móveis não conseguem acessá-lo até habilitar LAN/Tailscale.".into()
            },
        };

        let (workflow_event_tx, _) = broadcast::channel(512);
        let state = Arc::new(AppState {
            processes: processes.clone(),
            usage,
            workflows,
            workflow_runner,
            workflow_history,
            workflow_executions: WorkflowExecutionRegistry::default(),
            workflow_events: workflow_event_tx,
            checkpoint_dir,
            approvals,
            claude_approvals,
            claude_manager: claude_manager.clone(),
            codex_manager: codex_manager.clone(),
            sessions: sessions.clone(),
            devices,
            pairing: AsyncMutex::new(None),
            allowed_root: canonical_or_original(config.allowed_root),
            hub: EventHub::new(),
        });
        let router = Router::new()
            .route("/health", get(health))
            .route("/api/v1/pair", post(pair_device))
            .route("/api/v1/tasks", get(list_tasks).post(start_task))
            .route("/api/v1/tasks/{id}", get(get_task).delete(cancel_task))
            .route("/api/v1/usage", get(get_usage))
            .route("/api/v1/workflows", get(list_workflows))
            .route("/api/v1/workflows/{id}/run", post(start_remote_workflow))
            .route(
                "/api/v1/workflow-executions",
                get(list_remote_workflow_executions),
            )
            .route(
                "/api/v1/workflow-checkpoints",
                get(list_remote_workflow_checkpoints),
            )
            .route(
                "/api/v1/workflow-executions/{id}/cancel",
                post(cancel_remote_workflow),
            )
            .route("/api/v1/approvals", get(list_approvals))
            .route("/api/v1/sessions", get(list_managed_sessions))
            .route("/api/v1/providers", get(list_provider_capabilities))
            .route("/api/v1/sessions/{id}/resume", post(resume_managed_session))
            .route("/api/v1/sessions/{id}/messages", post(send_session_message))
            .route("/api/v1/sessions/{id}/stop", post(stop_managed_session))
            .route("/api/v1/approvals/{id}/decision", post(decide_approval))
            .route("/api/v1/devices", get(list_devices))
            .route("/ws", get(websocket_handler))
            .with_state(state.clone());

        let shutdown = CancellationToken::new();
        let server_shutdown = shutdown.clone();
        let server_task = tokio::spawn(async move {
            let result = axum::serve(listener, router)
                .with_graceful_shutdown(server_shutdown.cancelled_owned())
                .await;
            if let Err(error) = result {
                warn!(%error, "remote server stopped with an error");
            }
        });

        let relay_state = state.clone();
        let forwarder_task = tokio::spawn(async move {
            loop {
                match process_events.recv().await {
                    Ok(event) => relay_state.hub.publish(event).await,
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        warn!(
                            skipped,
                            "remote event relay lagged; connected clients will need a snapshot"
                        );
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });

        info!(
            port = actual_addr.port(),
            lan = config.enable_lan,
            "remote server started"
        );
        Ok(Self {
            info,
            state,
            shutdown,
            server_task,
            forwarder_task,
        })
    }

    fn info(&self) -> RemoteServerInfo {
        self.info.clone()
    }

    async fn create_pairing(&self) -> Result<PairingInfo, RemoteServerError> {
        let code = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let expires_at = Utc::now() + ChronoDuration::seconds(PAIRING_TTL_SECONDS);
        let mut pairing = self.state.pairing.lock().await;
        *pairing = Some(PairingChallenge {
            code: code.clone(),
            expires_at,
        });
        let payload = serde_json::json!({
            "version": 1,
            "endpoints": self.info.endpoints,
            "pairing_code": code,
            "expires_at": expires_at,
        });
        let qr_payload = serde_json::to_string(&payload)
            .map_err(|error| RemoteServerError::Database(error.to_string()))?;
        Ok(PairingInfo {
            version: 1,
            endpoints: self.info.endpoints.clone(),
            pairing_code: code,
            expires_at,
            qr_payload,
        })
    }

    async fn stop(self) {
        self.shutdown.cancel();
        self.forwarder_task.abort();
        let _ = timeout(Duration::from_secs(3), self.server_task).await;
    }
}

struct PairingChallenge {
    code: String,
    expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
struct RemoteWorkflowExecution {
    run_id: Uuid,
    workflow_id: Uuid,
    workflow_name: String,
    status: String,
    started_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    events: Vec<WorkflowProgressEvent>,
    result: Option<WorkflowRunResult>,
    error: Option<String>,
}

#[derive(Clone, Default)]
struct WorkflowExecutionRegistry {
    snapshots: Arc<AsyncMutex<std::collections::HashMap<Uuid, RemoteWorkflowExecution>>>,
    cancellations:
        Arc<AsyncMutex<std::collections::HashMap<Uuid, tokio::sync::watch::Sender<bool>>>>,
}

struct AppState {
    processes: ProcessManager,
    usage: UsageMonitor,
    workflows: WorkflowStore,
    workflow_runner: WorkflowRunner,
    workflow_history: WorkflowRunStore,
    workflow_executions: WorkflowExecutionRegistry,
    workflow_events: broadcast::Sender<WorkflowProgressEvent>,
    checkpoint_dir: PathBuf,
    approvals: CodexApprovalBridge,
    claude_approvals: ClaudeApprovalBridge,
    claude_manager: ClaudeCodeManager,
    codex_manager: CodexAppServerManager,
    sessions: SessionRegistry,
    devices: DeviceStore,
    pairing: AsyncMutex<Option<PairingChallenge>>,
    allowed_root: PathBuf,
    hub: EventHub,
}

#[derive(Clone)]
struct DeviceStore {
    connection: Arc<Mutex<Connection>>,
}

impl DeviceStore {
    fn open(path: PathBuf) -> Result<Self, RemoteServerError> {
        let connection = Connection::open(path)
            .map_err(|error| RemoteServerError::Database(error.to_string()))?;
        connection
            .busy_timeout(Duration::from_secs(2))
            .map_err(|error| RemoteServerError::Database(error.to_string()))?;
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS paired_devices (
                id TEXT PRIMARY KEY NOT NULL,
                name TEXT NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                last_seen_at TEXT,
                revoked_at TEXT
             );",
            )
            .map_err(|error| RemoteServerError::Database(error.to_string()))?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    async fn add(&self, name: String, token: &str) -> Result<String, ApiError> {
        let store = self.clone();
        let token_hash = hash_token(token);
        tokio::task::spawn_blocking(move || {
            let id = Uuid::new_v4().to_string();
            let now = Utc::now().to_rfc3339();
            let connection = store.connection.lock().map_err(|_| ApiError::internal("database mutex poisoned"))?;
            connection.execute(
                "INSERT INTO paired_devices(id, name, token_hash, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![id, name, token_hash, now],
            ).map_err(|error| ApiError::internal(error.to_string()))?;
            Ok(id)
        }).await.map_err(|error| ApiError::internal(error.to_string()))?
    }

    async fn authenticate(&self, token: &str) -> Result<DeviceIdentity, ApiError> {
        let store = self.clone();
        let token_hash = hash_token(token);
        tokio::task::spawn_blocking(move || {
            let connection = store
                .connection
                .lock()
                .map_err(|_| ApiError::internal("database mutex poisoned"))?;
            let row = connection.query_row(
                "SELECT id, name FROM paired_devices WHERE token_hash=?1 AND revoked_at IS NULL",
                params![token_hash],
                |row| Ok(DeviceIdentity { id: row.get(0)?, name: row.get(1)? }),
            ).optional().map_err(|error| ApiError::internal(error.to_string()))?;
            let device =
                row.ok_or_else(|| ApiError::unauthorized("device token inválido ou revogado"))?;
            let now = Utc::now().to_rfc3339();
            connection
                .execute(
                    "UPDATE paired_devices SET last_seen_at=?1 WHERE id=?2",
                    params![now, device.id],
                )
                .map_err(|error| ApiError::internal(error.to_string()))?;
            Ok(device)
        })
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?
    }

    async fn list(&self) -> Result<Vec<PairedDevice>, RemoteServerError> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || {
            let connection = store.connection.lock().map_err(|_| RemoteServerError::Database("database mutex poisoned".into()))?;
            let mut statement = connection.prepare(
                "SELECT id, name, created_at, last_seen_at FROM paired_devices WHERE revoked_at IS NULL ORDER BY created_at DESC"
            ).map_err(|error| RemoteServerError::Database(error.to_string()))?;
            let rows = statement.query_map([], |row| Ok(PairedDevice {
                id: row.get(0)?, name: row.get(1)?, created_at: row.get(2)?, last_seen_at: row.get(3)?,
            })).map_err(|error| RemoteServerError::Database(error.to_string()))?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|error| RemoteServerError::Database(error.to_string()))
        }).await.map_err(|error| RemoteServerError::Database(error.to_string()))?
    }

    async fn revoke(&self, id: String) -> Result<(), RemoteServerError> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || {
            let connection = store
                .connection
                .lock()
                .map_err(|_| RemoteServerError::Database("database mutex poisoned".into()))?;
            connection
                .execute(
                    "UPDATE paired_devices SET revoked_at=?1 WHERE id=?2",
                    params![Utc::now().to_rfc3339(), id],
                )
                .map_err(|error| RemoteServerError::Database(error.to_string()))?;
            Ok(())
        })
        .await
        .map_err(|error| RemoteServerError::Database(error.to_string()))?
    }
}

#[derive(Debug, Clone)]
struct DeviceIdentity {
    id: String,
    name: String,
}

fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

#[derive(Debug, Clone, Serialize)]
struct JournalItem {
    sequence: u64,
    event: TaskEvent,
}

struct EventJournalState {
    next_sequence: u64,
    entries: VecDeque<JournalItem>,
}

struct EventHub {
    journal: Mutex<EventJournalState>,
    sender: broadcast::Sender<JournalItem>,
}

impl EventHub {
    fn new() -> Self {
        let (sender, _) = broadcast::channel(2_048);
        Self {
            journal: Mutex::new(EventJournalState {
                next_sequence: 0,
                entries: VecDeque::new(),
            }),
            sender,
        }
    }

    async fn publish(&self, event: TaskEvent) {
        let item = {
            let mut journal = self.journal.lock().expect("event journal mutex poisoned");
            journal.next_sequence += 1;
            let item = JournalItem {
                sequence: journal.next_sequence,
                event,
            };
            journal.entries.push_back(item.clone());
            while journal.entries.len() > EVENT_JOURNAL_CAPACITY {
                journal.entries.pop_front();
            }
            item
        };
        let _ = self.sender.send(item);
    }

    async fn replay_after(&self, last_sequence: u64) -> Option<(u64, Vec<JournalItem>)> {
        let journal = self.journal.lock().ok()?;
        let high_water = journal.next_sequence;
        let oldest = journal
            .entries
            .front()
            .map(|item| item.sequence)
            .unwrap_or(high_water + 1);
        if last_sequence > high_water || last_sequence.saturating_add(1) < oldest {
            return None;
        }
        Some((
            high_water,
            journal
                .entries
                .iter()
                .filter(|item| item.sequence > last_sequence)
                .cloned()
                .collect(),
        ))
    }

    async fn sequence(&self) -> u64 {
        self.journal
            .lock()
            .expect("event journal mutex poisoned")
            .next_sequence
    }
}

#[derive(Debug, Deserialize)]
struct PairRequest {
    pairing_code: String,
    device_name: String,
}

#[derive(Debug, Deserialize)]
struct WsAuthRequest {
    #[serde(rename = "type")]
    message_type: String,
    token: String,
    #[serde(default)]
    last_sequence: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
enum ServerMessage {
    Authenticated {
        device_id: String,
        device_name: String,
    },
    Snapshot {
        sequence: u64,
        tasks: Vec<TaskSnapshot>,
        usage: UsageSnapshot,
    },
    Replay {
        high_water: u64,
        events: Vec<JournalItem>,
    },
    Event {
        item: JournalItem,
    },
    Usage {
        usage: UsageSnapshot,
    },
    WorkflowEvent {
        event: WorkflowProgressEvent,
    },
    Pong,
    Error {
        code: String,
        message: String,
    },
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
    protocol_version: u8,
}

#[derive(Debug, Error)]
#[error("{message}")]
struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }
    fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", message)
    }
    fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden", message)
    }
    fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "bad_request", message)
    }
    fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", message)
    }
    fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", message)
    }
    fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, "provider_conflict", message.into())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(serde_json::json!({"error": {"code": self.code, "message": self.message}})),
        )
            .into_response()
    }
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        protocol_version: 1,
    })
}

async fn pair_device(
    State(state): State<Arc<AppState>>,
    Json(request): Json<PairRequest>,
) -> Result<Json<PairResponse>, ApiError> {
    if request.device_name.trim().is_empty() || request.device_name.trim().len() > 80 {
        return Err(ApiError::bad_request(
            "device_name deve possuir entre 1 e 80 caracteres",
        ));
    }
    let mut pairing = state.pairing.lock().await;
    let challenge = pairing
        .as_ref()
        .ok_or_else(|| ApiError::unauthorized("nenhum pareamento está ativo"))?;
    if challenge.expires_at < Utc::now() {
        *pairing = None;
        return Err(ApiError::unauthorized("código de pareamento expirado"));
    }
    if challenge.code != request.pairing_code {
        return Err(ApiError::unauthorized("código de pareamento inválido"));
    }
    let token = format!("{}.{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let device_id = state
        .devices
        .add(request.device_name.trim().to_string(), &token)
        .await?;
    *pairing = None; // one-time challenge is consumed only after durable credential storage
    Ok(Json(PairResponse {
        device_id,
        device_token: token,
        server_time: Utc::now(),
    }))
}

fn bearer_token(headers: &HeaderMap) -> Result<&str, ApiError> {
    let value = headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| ApiError::unauthorized("Authorization Bearer ausente"))?;
    value
        .strip_prefix("Bearer ")
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| ApiError::unauthorized("Authorization deve usar Bearer"))
}

async fn authenticate_headers(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<DeviceIdentity, ApiError> {
    state.devices.authenticate(bearer_token(headers)?).await
}

async fn list_tasks(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Vec<TaskSnapshot>>, ApiError> {
    authenticate_headers(&state, &headers).await?;
    Ok(Json(state.processes.list_tasks().await))
}

async fn get_task(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<TaskSnapshot>, ApiError> {
    authenticate_headers(&state, &headers).await?;
    let task_id = id
        .parse::<TaskId>()
        .map_err(|_| ApiError::bad_request("task id inválido"))?;
    state
        .processes
        .get_task(task_id)
        .await
        .map(Json)
        .ok_or_else(|| ApiError::not_found("tarefa não encontrada"))
}

async fn start_task(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<AgentLaunchRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    authenticate_headers(&state, &headers).await?;
    let cwd = std::fs::canonicalize(&request.cwd)
        .map_err(|_| ApiError::bad_request("cwd não existe ou não pode ser canonicalizado"))?;
    if !path_is_within(&cwd, &state.allowed_root) {
        return Err(ApiError::forbidden(
            "diretório fora da raiz autorizada para controle remoto",
        ));
    }
    let mut request = request;
    request.cwd = cwd;
    let spec =
        build_process_spec(request).map_err(|error| ApiError::bad_request(error.to_string()))?;
    let id = state
        .processes
        .start(spec)
        .await
        .map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Json(serde_json::json!({"task_id": id})))
}

async fn cancel_task(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    authenticate_headers(&state, &headers).await?;
    let task_id = id
        .parse::<TaskId>()
        .map_err(|_| ApiError::bad_request("task id inválido"))?;
    state
        .processes
        .cancel(task_id)
        .await
        .map_err(|error| ApiError::not_found(error.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_usage(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<UsageSnapshot>, ApiError> {
    authenticate_headers(&state, &headers).await?;
    let tasks = state.processes.list_tasks().await;
    Ok(Json(state.usage.snapshot(&tasks).await))
}

async fn list_workflows(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Vec<WorkflowDefinition>>, ApiError> {
    authenticate_headers(&state, &headers).await?;
    state
        .workflows
        .list()
        .await
        .map(Json)
        .map_err(|error| ApiError::internal(format!("não foi possível listar workflows: {error}")))
}

#[derive(Debug, Deserialize)]
struct StartRemoteWorkflowRequest {
    repository: PathBuf,
    initial_prompt: String,
    #[serde(default)]
    policy: Option<WorkflowRunPolicy>,
}

async fn start_remote_workflow(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(request): Json<StartRemoteWorkflowRequest>,
) -> Result<Json<RemoteWorkflowExecution>, ApiError> {
    let _device = authenticate_headers(&state, &headers).await?;
    if request.initial_prompt.trim().is_empty() {
        return Err(ApiError::bad_request("prompt inicial vazio"));
    }
    let workflow_id = id
        .parse::<Uuid>()
        .map_err(|_| ApiError::bad_request("workflow id inválido"))?;
    let workflow = state
        .workflows
        .list()
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?
        .into_iter()
        .find(|item| item.id == workflow_id)
        .ok_or_else(|| ApiError::not_found("workflow não encontrado"))?;
    let repository = std::fs::canonicalize(&request.repository)
        .map_err(|_| ApiError::bad_request("diretório do projeto não existe"))?;
    if !repository.is_dir() || !path_is_within(&repository, &state.allowed_root) {
        return Err(ApiError::forbidden(
            "workspace fora da raiz permitida pelo Host",
        ));
    }
    let run_id = Uuid::new_v4();
    let now = Utc::now();
    let snapshot = RemoteWorkflowExecution {
        run_id,
        workflow_id,
        workflow_name: workflow.name.clone(),
        status: "queued".into(),
        started_at: now,
        updated_at: now,
        events: Vec::new(),
        result: None,
        error: None,
    };
    {
        let mut snapshots = state.workflow_executions.snapshots.lock().await;
        snapshots.insert(run_id, snapshot.clone());
        if snapshots.len() > 100 {
            let mut ordered: Vec<_> = snapshots
                .values()
                .map(|item| (item.started_at, item.run_id))
                .collect();
            ordered.sort_by_key(|item| item.0);
            for (_, old_id) in ordered
                .into_iter()
                .take(snapshots.len().saturating_sub(100))
            {
                snapshots.remove(&old_id);
            }
        }
    }
    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    state
        .workflow_executions
        .cancellations
        .lock()
        .await
        .insert(run_id, cancel_tx);
    let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();
    let runner = state.workflow_runner.clone();
    let history = state.workflow_history.clone();
    let registry = state.workflow_executions.clone();
    let broadcast = state.workflow_events.clone();
    let policy = request.policy.unwrap_or_default();
    let checkpoint_dir = state.checkpoint_dir.clone();
    tokio::spawn(async move {
        let run_request = WorkflowRunRequest {
            workflow,
            repository,
            initial_prompt: request.initial_prompt,
            policy,
            run_id: Some(run_id),
            checkpoint_path: Some(checkpoint_dir),
            resume: None,
        };
        let mut execution = tokio::spawn(async move {
            runner
                .run_controlled(run_request, cancel_rx, event_tx)
                .await
        });
        let mut events_open = true;
        loop {
            tokio::select! {
                event = event_rx.recv(), if events_open => {
                    if let Some(event) = event {
                        if let Some(snapshot) = registry.snapshots.lock().await.get_mut(&run_id) {
                            snapshot.status = if matches!(event.event.as_str(), "started" | "cancelled" | "finished") { event.status.clone() } else if snapshot.status == "queued" { "running".into() } else { snapshot.status.clone() };
                            snapshot.updated_at = Utc::now();
                            snapshot.events.push(event.clone());
                            if snapshot.events.len() > 500 { snapshot.events.remove(0); }
                        }
                        let _ = broadcast.send(event);
                    } else { events_open = false; }
                }
                result = &mut execution => {
                    let (status, value, error) = match result {
                        Ok(Ok(value)) => (value.status.clone(), Some(value), None),
                        Ok(Err(error)) => { let message = error.to_string(); (if message.contains("cancelado") { "cancelled" } else { "failed" }.to_string(), None, Some(message)) },
                        Err(error) => ("failed".into(), None, Some(format!("falha interna: {error}"))),
                    };
                    if let Some(value) = value.as_ref() { let _ = history.record(value.clone()).await; }
                    if let Some(snapshot) = registry.snapshots.lock().await.get_mut(&run_id) {
                        snapshot.status = status; snapshot.updated_at = Utc::now(); snapshot.result = value; snapshot.error = error;
                    }
                    registry.cancellations.lock().await.remove(&run_id);
                    break;
                }
            }
        }
    });
    Ok(Json(snapshot))
}

async fn list_remote_workflow_executions(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Vec<RemoteWorkflowExecution>>, ApiError> {
    authenticate_headers(&state, &headers).await?;
    let mut active: Vec<_> = state
        .workflow_executions
        .snapshots
        .lock()
        .await
        .values()
        .cloned()
        .collect();
    active.sort_by_key(|a| std::cmp::Reverse(a.started_at));
    let history = state
        .workflow_history
        .list(100)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    for item in history {
        if !active.iter().any(|entry| entry.run_id == item.run_id) {
            active.push(RemoteWorkflowExecution {
                run_id: item.run_id,
                workflow_id: item.workflow_id,
                workflow_name: "Workflow concluído".into(),
                status: item.status.clone(),
                started_at: item.started_at,
                updated_at: item.finished_at,
                events: Vec::new(),
                result: Some(item),
                error: None,
            });
        }
    }
    active.sort_by_key(|a| std::cmp::Reverse(a.started_at));
    active.truncate(100);
    Ok(Json(active))
}

async fn list_remote_workflow_checkpoints(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Vec<WorkflowCheckpoint>>, ApiError> {
    authenticate_headers(&state, &headers).await?;
    let checkpoints = WorkflowCheckpointStore::new(state.checkpoint_dir.clone())
        .list()
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    Ok(Json(checkpoints))
}

async fn cancel_remote_workflow(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    authenticate_headers(&state, &headers).await?;
    let run_id = id
        .parse::<Uuid>()
        .map_err(|_| ApiError::bad_request("run_id inválido"))?;
    let sender = state
        .workflow_executions
        .cancellations
        .lock()
        .await
        .get(&run_id)
        .cloned()
        .ok_or_else(|| ApiError::not_found("workflow não está em execução"))?;
    sender.send(true).map_err(|_| {
        ApiError::new(
            StatusCode::CONFLICT,
            "workflow_finished",
            "workflow já encerrou",
        )
    })?;
    Ok(StatusCode::ACCEPTED)
}

#[derive(Debug, Deserialize)]
struct ApprovalDecisionRequest {
    approve: bool,
}

async fn list_provider_capabilities(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Vec<provider_runtime::ProviderCapabilities>>, ApiError> {
    authenticate_headers(&state, &headers).await?;
    Ok(Json(provider_runtime::catalog()))
}

async fn list_managed_sessions(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Vec<ManagedSession>>, ApiError> {
    authenticate_headers(&state, &headers).await?;
    Ok(Json(state.sessions.list().await))
}

#[derive(Debug, Deserialize)]
struct ResumeSessionRequest {
    prompt: String,
}

async fn resume_managed_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(request): Json<ResumeSessionRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let device = authenticate_headers(&state, &headers).await?;
    if request.prompt.trim().is_empty() {
        return Err(ApiError::bad_request("prompt vazio"));
    }
    let id = id
        .parse::<Uuid>()
        .map_err(|_| ApiError::bad_request("session id inválido"))?;
    let previous = state
        .sessions
        .get(id)
        .await
        .ok_or_else(|| ApiError::not_found("sessão não encontrada"))?;
    if matches!(previous.status.as_str(), "running" | "starting") {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "session_running",
            "esta sessão já possui uma execução em andamento",
        ));
    }
    if previous.recovery_mode != RecoveryMode::NativeResume {
        return Err(ApiError::bad_request("sessão não possui retomada nativa"));
    }
    let cwd = std::fs::canonicalize(&previous.cwd)
        .map_err(|_| ApiError::bad_request("workspace da sessão não está disponível"))?;
    if !path_is_within(&cwd, &state.allowed_root) {
        return Err(ApiError::forbidden(
            "workspace fora da raiz autorizada para controle remoto",
        ));
    }
    let (new_id, provider, external_id, started_at) = match previous.provider {
        SessionProvider::ClaudeCode => {
            let native_id = previous
                .external_session_id
                .clone()
                .ok_or_else(|| ApiError::bad_request("sessão sem ID nativo do Claude Code"))?;
            let info = state
                .claude_manager
                .start(ClaudeStartRequest {
                    cwd: cwd.clone(),
                    prompt: request.prompt,
                    model: previous.model.clone(),
                    effort: None,
                    permission_mode: Some("default".into()),
                    resume_session_id: Some(native_id.clone()),
                })
                .await
                .map_err(|e| ApiError::internal(e.to_string()))?;
            (
                info.id,
                SessionProvider::ClaudeCode,
                Some(native_id),
                info.started_at,
            )
        }
        SessionProvider::Codex => {
            let native_id = previous
                .external_session_id
                .clone()
                .ok_or_else(|| ApiError::bad_request("sessão sem thread ID do Codex"))?;
            let info = state
                .codex_manager
                .start(CodexStartRequest {
                    cwd: cwd.clone(),
                    prompt: request.prompt,
                    model: previous.model.clone(),
                    sandbox: Some("workspace-write".into()),
                    persistent: Some(true),
                    resume_thread_id: Some(native_id.clone()),
                })
                .await
                .map_err(|e| ApiError::internal(e.to_string()))?;
            (
                info.id,
                SessionProvider::Codex,
                Some(native_id),
                info.started_at,
            )
        }
        SessionProvider::Antigravity => {
            return resume_antigravity_session(
                State(state),
                headers,
                Path(id.to_string()),
                Json(ResumeSessionRequest {
                    prompt: request.prompt,
                }),
            )
            .await;
        }
    };
    let managed = ManagedSession {
        id: new_id,
        provider,
        external_session_id: external_id,
        cwd,
        model: previous.model,
        status: "running".into(),
        recovery_mode: RecoveryMode::NativeResume,
        recovery_note: "Sessão retomada remotamente pelo protocolo nativo do provedor.".into(),
        started_at,
        updated_at: Utc::now(),
        last_error: None,
    };
    state
        .sessions
        .upsert(managed)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    info!(device_id = %device.id, previous_session_id = %id, resumed_session_id = %new_id, "native session resumed remotely");
    Ok(Json(serde_json::json!({"session_id": new_id})))
}

async fn send_session_message(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(request): Json<ResumeSessionRequest>,
) -> Result<StatusCode, ApiError> {
    authenticate_headers(&state, &headers).await?;
    if request.prompt.trim().is_empty() {
        return Err(ApiError::bad_request("prompt vazio"));
    }
    let id = id
        .parse::<Uuid>()
        .map_err(|_| ApiError::bad_request("session id inválido"))?;
    let session = state
        .sessions
        .get(id)
        .await
        .ok_or_else(|| ApiError::not_found("sessão não encontrada"))?;
    if session.status != "running" {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "session_not_running",
            "a sessão não está em execução",
        ));
    }
    match session.provider {
        SessionProvider::ClaudeCode => state
            .claude_manager
            .send_user_message(id, request.prompt)
            .await
            .map_err(|e| ApiError::conflict(e.to_string()))?,
        SessionProvider::Codex => state
            .codex_manager
            .send_user_message(id, request.prompt)
            .await
            .map_err(|e| ApiError::conflict(e.to_string()))?,
        SessionProvider::Antigravity => {
            return Err(ApiError::bad_request(
                "Antigravity executa um turno por processo; use retomada para enviar outro prompt",
            ))
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn stop_managed_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    authenticate_headers(&state, &headers).await?;
    let id = id
        .parse::<Uuid>()
        .map_err(|_| ApiError::bad_request("session id inválido"))?;
    let session = state
        .sessions
        .get(id)
        .await
        .ok_or_else(|| ApiError::not_found("sessão não encontrada"))?;
    match session.provider {
        SessionProvider::ClaudeCode => state
            .claude_manager
            .stop(id)
            .await
            .map_err(|e| ApiError::not_found(e.to_string()))?,
        SessionProvider::Codex => state
            .codex_manager
            .stop(id)
            .await
            .map_err(|e| ApiError::not_found(e.to_string()))?,
        SessionProvider::Antigravity => {
            return Err(ApiError::bad_request(
                "Para cancelar Antigravity, cancele a tarefa associada no painel de tarefas.",
            ))
        }
    }
    let _ = state.sessions.set_status(id, "stopped", None).await;
    Ok(StatusCode::NO_CONTENT)
}

async fn resume_antigravity_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(request): Json<ResumeSessionRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let device = authenticate_headers(&state, &headers).await?;
    if request.prompt.trim().is_empty() {
        return Err(ApiError::bad_request("prompt vazio"));
    }
    let id = id
        .parse::<Uuid>()
        .map_err(|_| ApiError::bad_request("session id inválido"))?;
    let session = state
        .sessions
        .get(id)
        .await
        .ok_or_else(|| ApiError::not_found("sessão não encontrada"))?;
    if session.provider != SessionProvider::Antigravity {
        return Err(ApiError::bad_request(
            "retomada remota disponível nesta etapa apenas para Antigravity",
        ));
    }
    if matches!(session.status.as_str(), "running" | "starting") {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "session_running",
            "esta sessão já possui uma execução em andamento",
        ));
    }
    if session.recovery_mode != RecoveryMode::NativeResume {
        return Err(ApiError::bad_request("sessão não possui retomada nativa"));
    }
    let native_id = session
        .external_session_id
        .clone()
        .ok_or_else(|| ApiError::bad_request("sessão sem conversation ID"))?;
    let cwd = std::fs::canonicalize(&session.cwd)
        .map_err(|_| ApiError::bad_request("workspace da sessão não está disponível"))?;
    if !path_is_within(&cwd, &state.allowed_root) {
        return Err(ApiError::forbidden(
            "workspace fora da raiz autorizada para controle remoto",
        ));
    }
    let spec = build_antigravity_spec(AntigravityRequest {
        cwd,
        prompt: request.prompt,
        model: session.model.clone(),
        effort: None,
        mode: None,
        conversation_id: Some(native_id),
    })
    .map_err(|e| ApiError::bad_request(e.to_string()))?;
    let mut events = state.processes.subscribe();
    let task_id = state
        .processes
        .start(spec)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    state
        .sessions
        .set_status(id, "running", None)
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    let sessions = state.sessions.clone();
    let mut record = session;
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from);
    tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(event) if event.task_id == task_id => {
                    if let TaskEventPayload::Exited { code } = event.payload {
                        record.status = if code == Some(0) { "idle" } else { "failed" }.into();
                        record.last_error = if code == Some(0) {
                            None
                        } else {
                            Some(format!("AGY encerrou com código {code:?}"))
                        };
                        if let Some(home) = home {
                            if let Ok(Some(native_id)) =
                                read_workspace_conversation(default_cache_path(home), &record.cwd)
                            {
                                record.external_session_id = Some(native_id);
                            }
                        }
                        record.updated_at = Utc::now();
                        let _ = sessions.upsert(record).await;
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
                _ => {}
            }
        }
    });
    info!(device_id = %device.id, session_id = %id, task_id = %task_id, "Antigravity session resumed remotely");
    Ok(Json(serde_json::json!({"task_id": task_id})))
}

async fn list_approvals(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Vec<PermissionRequest>>, ApiError> {
    authenticate_headers(&state, &headers).await?;
    let mut items = state.approvals.list().await;
    items.extend(state.claude_approvals.list().await);
    items.sort_by_key(|a| std::cmp::Reverse(a.created_at));
    Ok(Json(items))
}

async fn decide_approval(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(request): Json<ApprovalDecisionRequest>,
) -> Result<Json<PermissionRequest>, ApiError> {
    let device = authenticate_headers(&state, &headers).await?;
    let id = id
        .parse::<Uuid>()
        .map_err(|_| ApiError::bad_request("approval id inválido"))?;
    let provider = state
        .approvals
        .list()
        .await
        .into_iter()
        .chain(state.claude_approvals.list().await)
        .find(|item| item.id == id)
        .map(|item| item.provider);
    let decision = if provider.as_deref() == Some("claude_code") {
        state
            .claude_approvals
            .decide(id, request.approve, format!("mobile:{}", device.id))
            .await
    } else {
        state
            .approvals
            .decide(id, request.approve, format!("mobile:{}", device.id))
            .await
    };
    decision.map(Json).map_err(|error| match error {
        permission_engine::PermissionError::NotFound => ApiError::not_found(error.to_string()),
        permission_engine::PermissionError::NotPending => {
            ApiError::new(StatusCode::CONFLICT, "not_pending", error.to_string())
        }
        permission_engine::PermissionError::InvalidActor => {
            ApiError::bad_request(error.to_string())
        }
        _ => ApiError::internal(error.to_string()),
    })
}

async fn list_devices(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Vec<PairedDevice>>, ApiError> {
    authenticate_headers(&state, &headers).await?;
    state
        .devices
        .list()
        .await
        .map(Json)
        .map_err(|error| ApiError::internal(error.to_string()))
}

async fn websocket_handler(State(state): State<Arc<AppState>>, ws: WebSocketUpgrade) -> Response {
    ws.max_message_size(MAX_WS_FRAME_BYTES)
        .on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(mut socket: WebSocket, state: Arc<AppState>) {
    let first = timeout(WS_AUTH_TIMEOUT, socket.recv()).await;
    let auth_text = match first {
        Ok(Some(Ok(Message::Text(text)))) => text,
        _ => return,
    };
    let auth: WsAuthRequest = match serde_json::from_str::<WsAuthRequest>(auth_text.as_str()) {
        Ok(value) if value.message_type == "authenticate" => value,
        _ => {
            let _ = send_ws(
                &mut socket,
                &ServerMessage::Error {
                    code: "invalid_auth".into(),
                    message: "primeiro frame deve ser authenticate".into(),
                },
            )
            .await;
            return;
        }
    };
    let device = match state.devices.authenticate(&auth.token).await {
        Ok(device) => device,
        Err(error) => {
            let _ = send_ws(
                &mut socket,
                &ServerMessage::Error {
                    code: error.code.into(),
                    message: error.message,
                },
            )
            .await;
            return;
        }
    };
    if send_ws(
        &mut socket,
        &ServerMessage::Authenticated {
            device_id: device.id,
            device_name: device.name,
        },
    )
    .await
    .is_err()
    {
        return;
    }

    // Subscribe before reading the journal/snapshot to avoid a reconnect race.
    // Events at or below the returned high-water mark are skipped below.
    let mut events = state.hub.sender.subscribe();
    let mut workflow_events = state.workflow_events.subscribe();
    let mut usage_refresh = tokio::time::interval(Duration::from_secs(10));
    let skip_through = if let Some(last_sequence) = auth.last_sequence {
        if let Some((high_water, replay)) = state.hub.replay_after(last_sequence).await {
            if send_ws(
                &mut socket,
                &ServerMessage::Replay {
                    high_water,
                    events: replay,
                },
            )
            .await
            .is_err()
            {
                return;
            }
            high_water
        } else {
            let tasks = state.processes.list_tasks().await;
            let usage = state.usage.snapshot(&tasks).await;
            let sequence = state.hub.sequence().await;
            if send_ws(
                &mut socket,
                &ServerMessage::Snapshot {
                    sequence,
                    tasks,
                    usage,
                },
            )
            .await
            .is_err()
            {
                return;
            }
            sequence
        }
    } else {
        let tasks = state.processes.list_tasks().await;
        let usage = state.usage.snapshot(&tasks).await;
        let sequence = state.hub.sequence().await;
        if send_ws(
            &mut socket,
            &ServerMessage::Snapshot {
                sequence,
                tasks,
                usage,
            },
        )
        .await
        .is_err()
        {
            return;
        }
        sequence
    };
    let mut heartbeat = tokio::time::interval(Duration::from_secs(25));
    loop {
        tokio::select! {
            workflow_event = workflow_events.recv() => match workflow_event {
                Ok(event) => if send_ws(&mut socket, &ServerMessage::WorkflowEvent { event }).await.is_err() { break; },
                Err(broadcast::error::RecvError::Lagged(_)) => { let _ = send_ws(&mut socket, &ServerMessage::Error { code: "workflow_resync_required".into(), message: "eventos de workflow perdidos; consulte /api/v1/workflow-executions".into() }).await; },
                Err(broadcast::error::RecvError::Closed) => {},
            },
            item = events.recv() => match item {
                Ok(item) if item.sequence > skip_through => if send_ws(&mut socket, &ServerMessage::Event { item }).await.is_err() { break; },
                Ok(_) => {},
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    warn!(skipped, "remote client fell behind; reconnect with last_sequence for replay or snapshot");
                    let _ = send_ws(&mut socket, &ServerMessage::Error { code: "resync_required".into(), message: "eventos perdidos; reconecte usando o último sequence".into() }).await;
                    break;
                },
                Err(broadcast::error::RecvError::Closed) => break,
            },
            incoming = socket.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    if text.as_str() == "ping"
                        && send_ws(&mut socket, &ServerMessage::Pong).await.is_err()
                    {
                        break;
                    }
                }
                Some(Ok(Message::Ping(payload))) => if socket.send(Message::Pong(payload)).await.is_err() { break; },
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {},
            },
            _ = heartbeat.tick() => if socket.send(Message::Ping(Vec::new().into())).await.is_err() { break; },
            _ = usage_refresh.tick() => {
                let tasks = state.processes.list_tasks().await;
                let usage = state.usage.snapshot(&tasks).await;
                if send_ws(&mut socket, &ServerMessage::Usage { usage }).await.is_err() { break; }
            },
        }
    }
}

async fn send_ws(socket: &mut WebSocket, message: &ServerMessage) -> Result<(), ()> {
    let text = serde_json::to_string(message).map_err(|_| ())?;
    socket
        .send(Message::Text(text.into()))
        .await
        .map_err(|_| ())
}

fn path_is_within(path: &FsPath, root: &FsPath) -> bool {
    #[cfg(windows)]
    {
        let path = path.to_string_lossy().to_ascii_lowercase();
        let root = root.to_string_lossy().to_ascii_lowercase();
        path == root || path.starts_with(&format!("{}\\", root.trim_end_matches('\\')))
    }
    #[cfg(not(windows))]
    {
        path == root || path.starts_with(&format!("{}/", root.trim_end_matches('/')))
    }
}

fn canonical_or_original(path: PathBuf) -> PathBuf {
    std::fs::canonicalize(&path).unwrap_or(path)
}

async fn advertised_endpoints(enable_lan: bool, port: u16) -> Vec<String> {
    if !enable_lan {
        return vec![format!("http://127.0.0.1:{port}")];
    }
    let mut addresses = Vec::<IpAddr>::new();
    if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("192.0.2.1:80").is_ok() {
            if let Ok(local) = socket.local_addr() {
                addresses.push(local.ip());
            }
        }
    }
    // Tailscale's CLI is optional and may not be installed. Bound the probe so
    // a broken CLI cannot delay starting the remote server indefinitely.
    if let Ok(Ok(output)) = timeout(
        Duration::from_secs(1),
        tokio::process::Command::new("tailscale")
            .args(["ip", "-4"])
            .output(),
    )
    .await
    {
        if output.status.success() {
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                if let Ok(address) = line.trim().parse::<IpAddr>() {
                    if !addresses.contains(&address) {
                        addresses.insert(0, address);
                    }
                }
            }
        }
    }
    addresses.dedup();
    addresses
        .into_iter()
        .filter(|ip| !ip.is_loopback())
        .map(|ip| format!("http://{ip}:{port}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_hash_is_one_way_and_stable() {
        let token = "unit-test-token";
        assert_eq!(hash_token(token), hash_token(token));
        assert_ne!(hash_token(token), token);
    }

    #[test]
    fn path_guard_accepts_root_descendant_and_rejects_sibling_prefix() {
        let base = std::env::temp_dir();
        let root = base.join(format!("orchestrator-root-{}", Uuid::new_v4()));
        let child = root.join("src");
        let sibling = root.with_file_name(format!(
            "{}-evil",
            root.file_name().unwrap().to_string_lossy()
        ));
        assert!(path_is_within(&child, &root));
        assert!(!path_is_within(&sibling, &root));
    }

    #[tokio::test]
    async fn paired_device_token_can_be_revoked() {
        let path =
            std::env::temp_dir().join(format!("psylium-device-{}.sqlite3", Uuid::new_v4()));
        let store = DeviceStore::open(path.clone()).unwrap();
        let token = "secret-test-token";
        let id = store.add("test phone".into(), token).await.unwrap();
        let authenticated = store.authenticate(token).await.unwrap();
        assert_eq!(authenticated.id, id);
        store.revoke(id).await.unwrap();
        assert!(store.authenticate(token).await.is_err());
        drop(store);
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn event_hub_replays_events_after_sequence() {
        let hub = EventHub::new();
        let event = TaskEvent {
            task_id: Uuid::new_v4(),
            sequence: 1,
            emitted_at: Utc::now(),
            payload: shared_protocol::TaskEventPayload::Exited { code: Some(0) },
        };
        hub.publish(event).await;
        let (high, events) = hub.replay_after(0).await.unwrap();
        assert_eq!(high, 1);
        assert_eq!(events.len(), 1);
    }

    #[tokio::test]
    async fn websocket_requires_device_token_and_sends_snapshot() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::{connect_async, tungstenite::Message as ClientMessage};

        let temp =
            std::env::temp_dir().join(format!("psylium-remote-{}.sqlite3", Uuid::new_v4()));
        let processes = ProcessManager::new(Default::default());
        let server = RemoteServer::start(
            RemoteServerConfig {
                enable_lan: false,
                port: 0,
                allowed_root: std::env::temp_dir(),
            },
            processes.clone(),
            UsageMonitor::default(),
            WorkflowStore::new(temp.with_extension("workflows")),
            WorkflowRunner::new(
                processes.clone(),
                workspace_manager::WorkspaceManager::new(temp.with_extension("worktrees")),
            ),
            WorkflowRunStore::new(temp.with_extension("workflow-runs.json")),
            CodexApprovalBridge::new(
                CodexAppServerManager::default(),
                permission_engine::PermissionEngine::default(),
            ),
            ClaudeApprovalBridge::new(
                claude_code_adapter::ClaudeCodeManager::default(),
                permission_engine::PermissionEngine::default(),
            ),
            ClaudeCodeManager::default(),
            CodexAppServerManager::default(),
            SessionRegistry::open(temp.with_extension("sessions.json"))
                .await
                .unwrap(),
            temp.clone(),
        )
        .await
        .unwrap();
        let token = format!("{}.{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        server
            .state
            .devices
            .add("integration test phone".into(), &token)
            .await
            .unwrap();
        let port = server.info.port;
        let (mut socket, _) = connect_async(format!("ws://127.0.0.1:{port}/ws"))
            .await
            .unwrap();
        let auth = serde_json::json!({"type":"authenticate", "token":token, "last_sequence":null});
        socket
            .send(ClientMessage::Text(auth.to_string().into()))
            .await
            .unwrap();
        let authenticated = socket.next().await.unwrap().unwrap();
        let ClientMessage::Text(authenticated) = authenticated else {
            panic!("expected text response")
        };
        let authenticated: serde_json::Value =
            serde_json::from_str(authenticated.as_str()).unwrap();
        assert_eq!(authenticated["type"], "authenticated");
        let snapshot = socket.next().await.unwrap().unwrap();
        let ClientMessage::Text(snapshot) = snapshot else {
            panic!("expected snapshot text")
        };
        let snapshot: serde_json::Value = serde_json::from_str(snapshot.as_str()).unwrap();
        assert_eq!(snapshot["type"], "snapshot");
        socket.close(None).await.unwrap();
        server.stop().await;
        let _ = std::fs::remove_file(temp);
    }
}
