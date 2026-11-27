//! Persistent registry for native provider sessions.
//!
//! The registry stores recovery metadata, not process handles or credentials. On
//! restart, sessions that were active are marked `interrupted`; providers must
//! explicitly resume them through their own supported APIs.
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};
use thiserror::Error;
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionProvider {
    ClaudeCode,
    Codex,
    Antigravity,
}

impl SessionProvider {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude_code",
            Self::Codex => "codex",
            Self::Antigravity => "antigravity",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryMode {
    NativeResume,
    MetadataOnly,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManagedSession {
    pub id: Uuid,
    pub provider: SessionProvider,
    pub external_session_id: Option<String>,
    pub cwd: PathBuf,
    pub model: Option<String>,
    pub status: String,
    pub recovery_mode: RecoveryMode,
    pub recovery_note: String,
    pub started_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub last_error: Option<String>,
}

#[derive(Debug, Error)]
pub enum SessionStoreError {
    #[error("falha de I/O no registro de sessões: {0}")]
    Io(#[from] std::io::Error),
    #[error("falha ao serializar registro de sessões: {0}")]
    Json(#[from] serde_json::Error),
    #[error("sessão gerenciada não encontrada")]
    NotFound,
}

#[derive(Clone)]
pub struct SessionRegistry {
    path: Arc<PathBuf>,
    records: Arc<Mutex<HashMap<Uuid, ManagedSession>>>,
    persist_lock: Arc<Mutex<()>>,
}

impl SessionRegistry {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, SessionStoreError> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let mut records: HashMap<Uuid, ManagedSession> = match tokio::fs::read(&path).await {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
            Err(error) => return Err(error.into()),
        };
        let mut changed = false;
        for record in records.values_mut() {
            if matches!(
                record.status.as_str(),
                "starting" | "running" | "idle" | "awaiting_approval"
            ) {
                record.status = "interrupted".into();
                record.updated_at = Utc::now();
                record.recovery_note = match record.recovery_mode {
                    RecoveryMode::NativeResume => "O processo anterior não foi restaurado. Use o ID nativo para solicitar retomada explícita.".into(),
                    RecoveryMode::MetadataOnly => "Metadados recuperados; este provedor não possui retomada automática implementada.".into(),
                    RecoveryMode::Unsupported => "Este provedor não oferece retomada de sessão implementada.".into(),
                };
                changed = true;
            }
        }
        let registry = Self {
            path: Arc::new(path),
            records: Arc::new(Mutex::new(records)),
            persist_lock: Arc::new(Mutex::new(())),
        };
        if changed {
            registry.persist().await?;
        }
        Ok(registry)
    }

    pub async fn upsert(
        &self,
        mut record: ManagedSession,
    ) -> Result<ManagedSession, SessionStoreError> {
        record.updated_at = Utc::now();
        self.records.lock().await.insert(record.id, record.clone());
        self.persist().await?;
        Ok(record)
    }

    pub async fn set_status(
        &self,
        id: Uuid,
        status: impl Into<String>,
        error: Option<String>,
    ) -> Result<ManagedSession, SessionStoreError> {
        let updated = {
            let mut records = self.records.lock().await;
            let record = records.get_mut(&id).ok_or(SessionStoreError::NotFound)?;
            record.status = status.into();
            record.last_error = error;
            record.updated_at = Utc::now();
            record.clone()
        };
        self.persist().await?;
        Ok(updated)
    }

    pub async fn list(&self) -> Vec<ManagedSession> {
        let mut result = self
            .records
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        result.sort_by_key(|a| std::cmp::Reverse(a.updated_at));
        result
    }

    pub async fn get(&self, id: Uuid) -> Option<ManagedSession> {
        self.records.lock().await.get(&id).cloned()
    }

    async fn persist(&self) -> Result<(), SessionStoreError> {
        let _guard = self.persist_lock.lock().await;
        let snapshot = self.records.lock().await.clone();
        let bytes = serde_json::to_vec_pretty(&snapshot)?;
        let tmp = self.path.with_extension("json.tmp");
        tokio::fs::write(&tmp, bytes).await?;
        tokio::fs::rename(&tmp, self.path.as_ref()).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn active_sessions_are_marked_interrupted_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sessions.json");
        let registry = SessionRegistry::open(&path).await.unwrap();
        let id = Uuid::new_v4();
        registry
            .upsert(ManagedSession {
                id,
                provider: SessionProvider::Codex,
                external_session_id: Some("thread-1".into()),
                cwd: PathBuf::from("/repo"),
                model: None,
                status: "running".into(),
                recovery_mode: RecoveryMode::NativeResume,
                recovery_note: "".into(),
                started_at: Utc::now(),
                updated_at: Utc::now(),
                last_error: None,
            })
            .await
            .unwrap();
        drop(registry);
        let restored = SessionRegistry::open(&path).await.unwrap();
        let session = restored.get(id).await.unwrap();
        assert_eq!(session.status, "interrupted");
        assert_eq!(session.external_session_id.as_deref(), Some("thread-1"));
    }
}
