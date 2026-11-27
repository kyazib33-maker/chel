use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use thiserror::Error;
use tokio::{fs, process::Command, sync::Mutex};
use uuid::Uuid;

const OWNER_MARKER: &str = "ai-orchestrator-managed-worktree-v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateWorktreeRequest {
    pub repository: PathBuf,
    pub name: String,
    pub branch_name: String,
    #[serde(default = "default_base_ref")]
    pub base_ref: String,
}

fn default_base_ref() -> String {
    "HEAD".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorktreeInfo {
    pub id: Uuid,
    pub repository: PathBuf,
    pub path: PathBuf,
    pub name: String,
    pub branch_name: String,
    pub base_ref: String,
    pub created_at: DateTime<Utc>,
    pub present: bool,
    pub clean: bool,
    pub modified_files: usize,
    pub untracked_files: usize,
    pub staged_files: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WorktreeRecord {
    owner: String,
    info: WorktreeInfo,
}

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("Git não está disponível ou falhou: {0}")]
    Git(String),
    #[error("o caminho informado não é um repositório Git válido: {0}")]
    InvalidRepository(String),
    #[error("nome do worktree vazio")]
    EmptyName,
    #[error("nome de branch inválido: {0}")]
    InvalidBranch(String),
    #[error("referência base inválida: {0}")]
    InvalidBaseRef(String),
    #[error("worktree gerenciado não encontrado: {0}")]
    NotFound(Uuid),
    #[error("o caminho do worktree não pertence ao diretório gerenciado pelo aplicativo")]
    UnsafePath,
    #[error("registro do worktree inválido: {0}")]
    InvalidRecord(String),
    #[error("erro de arquivo: {0}")]
    Io(#[from] std::io::Error),
    #[error("erro de serialização: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Clone)]
pub struct WorkspaceManager {
    root: Arc<PathBuf>,
    operation_lock: Arc<Mutex<()>>,
}

impl WorkspaceManager {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root: Arc::new(root),
            operation_lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn root(&self) -> &Path {
        self.root.as_path()
    }

    pub async fn create(
        &self,
        request: CreateWorktreeRequest,
    ) -> Result<WorktreeInfo, WorkspaceError> {
        let _guard = self.operation_lock.lock().await;
        if request.name.trim().is_empty() {
            return Err(WorkspaceError::EmptyName);
        }
        let requested_repo = fs::canonicalize(&request.repository).await.map_err(|_| {
            WorkspaceError::InvalidRepository(request.repository.display().to_string())
        })?;
        let repo_output = git_output(&requested_repo, &["rev-parse", "--show-toplevel"]).await?;
        if !repo_output.status.success() {
            return Err(WorkspaceError::InvalidRepository(
                request.repository.display().to_string(),
            ));
        }
        let repository = PathBuf::from(String::from_utf8_lossy(&repo_output.stdout).trim());
        let repository = fs::canonicalize(repository).await.map_err(|_| {
            WorkspaceError::InvalidRepository(request.repository.display().to_string())
        })?;

        let branch_check = git_output(
            &repository,
            &["check-ref-format", "--branch", request.branch_name.trim()],
        )
        .await?;
        if !branch_check.status.success()
            || request.branch_name.trim().is_empty()
            || request.branch_name.trim().starts_with('-')
        {
            return Err(WorkspaceError::InvalidBranch(request.branch_name));
        }
        if request.base_ref.trim().is_empty() || request.base_ref.trim().starts_with('-') {
            return Err(WorkspaceError::InvalidBaseRef(request.base_ref));
        }
        let base_commit_ref = format!("{}^{{commit}}", request.base_ref.trim());
        let base_check = git_output(
            &repository,
            &["rev-parse", "--verify", "--quiet", base_commit_ref.as_str()],
        )
        .await?;
        if !base_check.status.success() {
            return Err(WorkspaceError::InvalidBaseRef(request.base_ref));
        }

        fs::create_dir_all(self.root.as_path()).await?;
        let root = strip_verbatim_prefix(fs::canonicalize(self.root.as_path()).await?);
        let repo_name = repository
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or("repository");
        let slug = slugify(repo_name);
        let branch_slug = slugify(&request.branch_name);
        let id = Uuid::new_v4();
        let path = root.join(format!(
            "{slug}-{}-{branch_slug}",
            &id.simple().to_string()[..8]
        ));

        let path_string = path.to_string_lossy().to_string();
        let add_output = git_output(
            &repository,
            &[
                "worktree",
                "add",
                "-b",
                request.branch_name.trim(),
                path_string.as_str(),
                request.base_ref.trim(),
            ],
        )
        .await?;
        if !add_output.status.success() {
            return Err(WorkspaceError::Git(stderr_text(&add_output.stderr)));
        }

        let info = WorktreeInfo {
            id,
            repository,
            path: path.clone(),
            name: request.name.trim().to_string(),
            branch_name: request.branch_name.trim().to_string(),
            base_ref: request.base_ref.trim().to_string(),
            created_at: Utc::now(),
            present: true,
            clean: true,
            modified_files: 0,
            untracked_files: 0,
            staged_files: 0,
        };
        let record = WorktreeRecord {
            owner: OWNER_MARKER.to_string(),
            info: info.clone(),
        };
        if let Err(error) = self.write_record(&record).await {
            let rollback_path = path.to_string_lossy().to_string();
            let _ = git_output(
                &info.repository,
                &["worktree", "remove", "--force", rollback_path.as_str()],
            )
            .await;
            return Err(error);
        }
        Ok(info)
    }

    pub async fn list(&self) -> Result<Vec<WorktreeInfo>, WorkspaceError> {
        let _guard = self.operation_lock.lock().await;
        fs::create_dir_all(self.root.as_path()).await?;
        let registry = self.registry_dir();
        fs::create_dir_all(&registry).await?;
        let mut entries = fs::read_dir(registry).await?;
        let mut result = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            if entry.path().extension().and_then(|v| v.to_str()) != Some("json") {
                continue;
            }
            let bytes = match fs::read(entry.path()).await {
                Ok(value) => value,
                Err(_) => continue,
            };
            let record: WorktreeRecord = match serde_json::from_slice(&bytes) {
                Ok(value) => value,
                Err(_) => continue,
            };
            if record.owner != OWNER_MARKER || !self.is_managed_path(&record.info.path).await? {
                continue;
            }
            let mut info = record.info;
            info.present = info.path.is_dir();
            if info.present {
                let status = git_output(
                    &info.path,
                    &["status", "--porcelain=v1", "--untracked-files=all"],
                )
                .await?;
                if status.status.success() {
                    let lines = String::from_utf8_lossy(&status.stdout);
                    info.modified_files = 0;
                    info.untracked_files = 0;
                    info.staged_files = 0;
                    for line in lines.lines() {
                        if line.len() < 2 {
                            continue;
                        }
                        let code = &line[..2];
                        if code == "??" {
                            info.untracked_files += 1;
                        } else {
                            if code.contains('M')
                                || code.contains('D')
                                || code.contains('A')
                                || code.contains('R')
                            {
                                info.modified_files += 1;
                            }
                            if code.chars().next().is_some_and(|c| c != ' ' && c != '?') {
                                info.staged_files += 1;
                            }
                        }
                    }
                }
            }
            info.clean =
                info.modified_files == 0 && info.untracked_files == 0 && info.staged_files == 0;
            result.push(info);
        }
        result.sort_by_key(|a| std::cmp::Reverse(a.created_at));
        Ok(result)
    }

    pub async fn remove(&self, id: Uuid, force: bool) -> Result<(), WorkspaceError> {
        let _guard = self.operation_lock.lock().await;
        let record_path = self.record_path(id);
        let bytes = fs::read(&record_path)
            .await
            .map_err(|_| WorkspaceError::NotFound(id))?;
        let record: WorktreeRecord = serde_json::from_slice(&bytes)?;
        if record.owner != OWNER_MARKER
            || record.info.id != id
            || !self.is_managed_path(&record.info.path).await?
        {
            return Err(WorkspaceError::UnsafePath);
        }
        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        let path_string = record.info.path.to_string_lossy().to_string();
        args.push(path_string.as_str());
        let output = git_output(&record.info.repository, &args).await?;
        if !output.status.success() {
            return Err(WorkspaceError::Git(stderr_text(&output.stderr)));
        }
        fs::remove_file(record_path).await?;
        Ok(())
    }

    async fn is_managed_path(&self, candidate: &Path) -> Result<bool, WorkspaceError> {
        let root = strip_verbatim_prefix(fs::canonicalize(self.root.as_path()).await?);
        let candidate = if candidate.exists() {
            strip_verbatim_prefix(fs::canonicalize(candidate).await?)
        } else {
            candidate.to_path_buf()
        };
        Ok(candidate != root && candidate.starts_with(&root))
    }

    async fn write_record(&self, record: &WorktreeRecord) -> Result<(), WorkspaceError> {
        let dir = self.registry_dir();
        fs::create_dir_all(&dir).await?;
        let target = self.record_path(record.info.id);
        let temp = dir.join(format!("{}.{}.tmp", record.info.id, Uuid::new_v4()));
        let bytes = serde_json::to_vec_pretty(record)?;
        fs::write(&temp, bytes).await?;
        if target.exists() {
            fs::remove_file(&target).await?;
        }
        fs::rename(temp, target).await?;
        Ok(())
    }

    fn registry_dir(&self) -> PathBuf {
        self.root.join(".registry")
    }
    fn record_path(&self, id: Uuid) -> PathBuf {
        self.registry_dir().join(format!("{id}.json"))
    }
}

async fn git_output(cwd: &Path, args: &[&str]) -> Result<std::process::Output, WorkspaceError> {
    Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .await
        .map_err(|error| WorkspaceError::Git(format!("não foi possível executar git: {error}")))
}

fn stderr_text(bytes: &[u8]) -> String {
    let value = String::from_utf8_lossy(bytes).trim().to_string();
    if value.is_empty() {
        "operação Git falhou sem mensagem de erro".to_string()
    } else {
        value
    }
}

fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(raw) = path.to_str() {
            if let Some(stripped) = raw.strip_prefix(r"\\?\") {
                return PathBuf::from(stripped);
            }
        }
    }
    path
}

fn slugify(value: &str) -> String {
    let slug: String = value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let cleaned = slug
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if cleaned.is_empty() {
        "workspace".to_string()
    } else {
        cleaned.chars().take(32).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;
    use tempfile::TempDir;

    fn git(path: &Path, args: &[&str]) {
        let output = StdCommand::new("git")
            .args(args)
            .current_dir(path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn create_repo() -> TempDir {
        let temp = TempDir::new().unwrap();
        git(temp.path(), &["init"]);
        git(
            temp.path(),
            &["config", "user.email", "orchestrator@test.local"],
        );
        git(
            temp.path(),
            &["config", "user.name", "Chel Test"],
        );
        git(temp.path(), &["commit", "--allow-empty", "-m", "initial"]);
        temp
    }

    #[tokio::test]
    async fn creates_lists_and_removes_managed_worktree() {
        let repo = create_repo();
        let root = TempDir::new().unwrap();
        let manager = WorkspaceManager::new(root.path().join("managed-worktrees"));
        let info = manager
            .create(CreateWorktreeRequest {
                repository: repo.path().to_path_buf(),
                name: "Backend implementation".into(),
                branch_name: "agent/backend-implementation".into(),
                base_ref: "HEAD".into(),
            })
            .await
            .unwrap();
        assert!(info.path.is_dir());
        let listed = manager.list().await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].branch_name, "agent/backend-implementation");
        manager.remove(info.id, false).await.unwrap();
        assert!(manager.list().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn refuses_to_remove_dirty_worktree_without_force() {
        let repo = create_repo();
        let root = TempDir::new().unwrap();
        let manager = WorkspaceManager::new(root.path().join("managed-worktrees"));
        let info = manager
            .create(CreateWorktreeRequest {
                repository: repo.path().to_path_buf(),
                name: "Frontend".into(),
                branch_name: "agent/frontend".into(),
                base_ref: "HEAD".into(),
            })
            .await
            .unwrap();
        fs::write(info.path.join("untracked.txt"), "keep me")
            .await
            .unwrap();
        assert!(manager.remove(info.id, false).await.is_err());
        assert!(info.path.exists());
        manager.remove(info.id, true).await.unwrap();
    }

    #[tokio::test]
    async fn cleans_stale_registry_when_worktree_directory_was_deleted_manually() {
        let repo = create_repo();
        let root = TempDir::new().unwrap();
        let manager = WorkspaceManager::new(root.path().join("managed-worktrees"));
        let info = manager
            .create(CreateWorktreeRequest {
                repository: repo.path().to_path_buf(),
                name: "Temporary".into(),
                branch_name: "agent/temporary".into(),
                base_ref: "HEAD".into(),
            })
            .await
            .unwrap();
        fs::remove_dir_all(&info.path).await.unwrap();
        manager.remove(info.id, false).await.unwrap();
        assert!(manager.list().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn rejects_invalid_branch_names() {
        let repo = create_repo();
        let root = TempDir::new().unwrap();
        let manager = WorkspaceManager::new(root.path().join("managed-worktrees"));
        let result = manager
            .create(CreateWorktreeRequest {
                repository: repo.path().to_path_buf(),
                name: "Bad branch".into(),
                branch_name: "../outside".into(),
                base_ref: "HEAD".into(),
            })
            .await;
        assert!(matches!(result, Err(WorkspaceError::InvalidBranch(_))));
    }
}
