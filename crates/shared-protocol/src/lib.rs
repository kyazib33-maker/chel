use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use uuid::Uuid;

pub type TaskId = Uuid;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ProviderId {
    ClaudeCode,
    Codex,
    Antigravity,
}

impl ProviderId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude_code",
            Self::Codex => "codex",
            Self::Antigravity => "antigravity",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Queued,
    Starting,
    Running,
    Cancelling,
    AwaitingApproval,
    Succeeded,
    Failed,
    QuotaExceeded,
    Cancelled,
}

impl TaskStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::QuotaExceeded | Self::Cancelled
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentLaunchRequest {
    pub provider: ProviderId,
    pub prompt: String,
    pub cwd: PathBuf,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    /// Continue an earlier conversation of the same provider instead of starting fresh.
    #[serde(default)]
    pub resume_id: Option<String>,
    /// Extra folders the AI may read/write (granted by the user in Chel).
    #[serde(default)]
    pub add_dirs: Vec<String>,
    /// Tools the user allowed without asking again (e.g. "Bash").
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    /// Extra instructions about the Chel environment.
    #[serde(default)]
    pub system_note: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ProcessSpec {
    pub provider: Option<ProviderId>,
    pub display_name: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// Executable name or absolute path. No shell is used to launch this command.
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
    pub timeout_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskSnapshot {
    pub task_id: TaskId,
    pub provider: Option<ProviderId>,
    pub display_name: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub program: String,
    pub cwd: PathBuf,
    #[serde(default)]
    pub current_file: Option<String>,
    #[serde(default)]
    pub last_file_change_at: Option<DateTime<Utc>>,
    pub status: TaskStatus,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub exit_code: Option<i32>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OutputStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum TaskEventPayload {
    StateChanged { status: TaskStatus },
    Output { stream: OutputStream, line: String },
    FileChanged { path: String },
    Exited { code: Option<i32> },
    Error { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskEvent {
    pub task_id: TaskId,
    pub sequence: u64,
    pub emitted_at: DateTime<Utc>,
    pub payload: TaskEventPayload,
}
