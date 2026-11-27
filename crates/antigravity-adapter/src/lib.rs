//! Antigravity CLI adapter.
//!
//! Uses documented AGY headless flags and native conversation IDs. It does not
//! claim a bidirectional approval protocol: runtime approvals remain governed
//! by Antigravity's own execution mode and permission settings.
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use shared_protocol::{ProcessSpec, ProviderId};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AntigravityRequest {
    pub cwd: PathBuf,
    pub prompt: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// `default`, `accept-edits`, `plan`, or `auto`.
    pub mode: Option<String>,
    pub conversation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedConversation {
    pub cwd: PathBuf,
    pub conversation_id: String,
    pub discovered_at: DateTime<Utc>,
}

#[derive(Debug, Error)]
pub enum AntigravityError {
    #[error("diretório de trabalho inválido: {0}")]
    InvalidCwd(String),
    #[error("prompt vazio")]
    EmptyPrompt,
    #[error("ID de conversa inválido")]
    InvalidConversationId,
    #[error("modo de execução inválido: {0}")]
    InvalidMode(String),
    #[error("nível de esforço inválido: {0}")]
    InvalidEffort(String),
    #[error("falha ao ler cache de conversas: {0}")]
    Io(#[from] std::io::Error),
    #[error("cache de conversas inválido: {0}")]
    Json(#[from] serde_json::Error),
}

pub fn build_process_spec(request: AntigravityRequest) -> Result<ProcessSpec, AntigravityError> {
    if !request.cwd.is_absolute() || !request.cwd.is_dir() {
        return Err(AntigravityError::InvalidCwd(
            request.cwd.display().to_string(),
        ));
    }
    if request.prompt.trim().is_empty() {
        return Err(AntigravityError::EmptyPrompt);
    }
    let mut args = vec![
        "-p".to_string(),
        request.prompt,
        "--output-format".into(),
        "stream-json".into(),
    ];
    let is_resume = request.conversation_id.is_some();
    if let Some(id) = request.conversation_id.as_ref() {
        if id.trim().is_empty() || id.chars().any(char::is_whitespace) {
            return Err(AntigravityError::InvalidConversationId);
        }
        args.extend(["--conversation".into(), id.clone()]);
    }
    if let Some(model) = request.model.as_ref() {
        args.extend(["--model".into(), model.clone()]);
    }
    if let Some(effort) = request.effort.as_ref() {
        if !["low", "medium", "high", "max"].contains(&effort.to_ascii_lowercase().as_str()) {
            return Err(AntigravityError::InvalidEffort(effort.clone()));
        }
        args.extend(["--effort".into(), effort.to_ascii_lowercase()]);
    }
    if let Some(mode) = request.mode.as_ref() {
        if !["accept-edits", "plan", "auto"].contains(&mode.as_str()) {
            return Err(AntigravityError::InvalidMode(mode.clone()));
        }
        args.extend(["--mode".into(), mode.clone()]);
    }
    // Permission-bypass switches are intentionally never added.
    Ok(ProcessSpec {
        provider: Some(ProviderId::Antigravity),
        display_name: if is_resume {
            "Antigravity session resume".into()
        } else {
            "Antigravity task".into()
        },
        model: request.model,
        effort: request.effort,
        program: "agy".into(),
        args,
        cwd: request.cwd,
        env: BTreeMap::new(),
        timeout_seconds: None,
    })
}

/// Reads Antigravity's documented workspace-to-last-conversation cache.
pub fn read_workspace_conversation(
    cache_path: impl AsRef<Path>,
    cwd: impl AsRef<Path>,
) -> Result<Option<String>, AntigravityError> {
    let bytes = match fs::read(cache_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let cache: BTreeMap<String, String> = serde_json::from_slice(&bytes)?;
    let wanted = normalize_path(cwd.as_ref());
    Ok(cache
        .into_iter()
        .find_map(|(path, id)| (normalize_path(Path::new(&path)) == wanted).then_some(id)))
}

pub fn default_cache_path(home: impl AsRef<Path>) -> PathBuf {
    home.as_ref()
        .join(".gemini")
        .join("antigravity-cli")
        .join("cache")
        .join("last_conversations.json")
}

fn normalize_path(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        value.to_ascii_lowercase()
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resume_uses_native_conversation_flag_and_safe_headless_mode() {
        let dir = tempfile::tempdir().unwrap();
        let spec = build_process_spec(AntigravityRequest {
            cwd: dir.path().to_path_buf(),
            prompt: "continue task".into(),
            model: None,
            effort: None,
            mode: None,
            conversation_id: Some("conv-123".into()),
        })
        .unwrap();
        assert_eq!(spec.program, "agy");
        assert!(spec
            .args
            .windows(2)
            .any(|pair| pair == ["--conversation", "conv-123"]));
        assert!(spec.args.iter().any(|arg| arg == "stream-json"));
        assert!(!spec.args.iter().any(|arg| arg.contains("skip-permissions")));
    }

    #[test]
    fn cache_lookup_is_workspace_scoped() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("last_conversations.json");
        let repo = dir.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        fs::write(
            &cache,
            serde_json::json!({ repo.to_string_lossy().to_string(): "conv-abc" }).to_string(),
        )
        .unwrap();
        assert_eq!(
            read_workspace_conversation(&cache, &repo)
                .unwrap()
                .as_deref(),
            Some("conv-abc")
        );
        assert_eq!(
            read_workspace_conversation(&cache, dir.path().join("other")).unwrap(),
            None
        );
    }
}
