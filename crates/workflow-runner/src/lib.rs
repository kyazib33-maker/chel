use chrono::{DateTime, Utc};
use process_manager::ProcessManager;
use provider_adapters::build_process_spec;
use shared_protocol::{AgentLaunchRequest, TaskEventPayload, TaskId, TaskStatus};
use std::{
    collections::{HashMap, HashSet},
    hash::Hasher,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use thiserror::Error;
use tokio::{process::Command, sync::Mutex, task::JoinSet, time::sleep};
use uuid::Uuid;
use workflow_engine::{
    validate_workflow, AgentNode, ContextMode, WorkflowDefinition, WorkflowEdge, WorktreeMode,
};
use workspace_manager::{CreateWorktreeRequest, WorkspaceManager};

const MAX_CONTEXT_BYTES: usize = 48 * 1024;
const MAX_NODE_OUTPUT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WorkflowRunPolicy {
    pub max_nodes: usize,
    pub max_node_runtime_seconds: u64,
    pub max_total_runtime_seconds: u64,
    pub max_output_bytes: usize,
    pub require_review_node: bool,
}

impl Default for WorkflowRunPolicy {
    fn default() -> Self {
        Self {
            max_nodes: 12,
            max_node_runtime_seconds: 3600,
            max_total_runtime_seconds: 10800,
            max_output_bytes: MAX_NODE_OUTPUT_BYTES,
            require_review_node: true,
        }
    }
}

#[derive(Debug, Clone)]
pub struct WorkflowRunRequest {
    pub workflow: WorkflowDefinition,
    pub repository: PathBuf,
    pub initial_prompt: String,
    pub policy: WorkflowRunPolicy,
    pub run_id: Option<Uuid>,
    /// Optional durable checkpoint file used to recover interrupted workflows.
    pub checkpoint_path: Option<PathBuf>,
    /// Present only when resuming a prior checkpoint after explicit preflight.
    pub resume: Option<WorkflowResumeInput>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WorkflowNodeResult {
    pub node_id: String,
    pub task_id: Option<TaskId>,
    pub status: String,
    pub output: String,
    pub error: Option<String>,
    pub started_at: DateTime<Utc>,
    pub finished_at: DateTime<Utc>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WorkflowRunResult {
    pub run_id: Uuid,
    pub workflow_id: Uuid,
    pub status: String,
    pub nodes: Vec<WorkflowNodeResult>,
    pub started_at: DateTime<Utc>,
    pub finished_at: DateTime<Utc>,
}

#[derive(Debug, Error)]
pub enum RunnerError {
    #[error("workflow inválido: {0}")]
    Invalid(String),
    #[error("diretório do projeto não existe ou não é absoluto")]
    InvalidRepository,
    #[error("política de execução inválida: {0}")]
    InvalidPolicy(String),
    #[error("falha ao executar nó {node}: {message}")]
    Node { node: String, message: String },
    #[error("workflow cancelado pelo usuário")]
    Cancelled,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WorkflowCheckpoint {
    pub run_id: Uuid,
    #[serde(default)]
    pub resumed_from: Option<Uuid>,
    pub process_id: u32,
    pub workflow: WorkflowDefinition,
    pub repository: PathBuf,
    pub initial_prompt: String,
    pub policy: WorkflowRunPolicy,
    pub completed_nodes: Vec<WorkflowNodeResult>,
    #[serde(default)]
    pub repository_fingerprint: Option<String>,
    /// A single managed worktree shared by a strictly sequential isolated workflow.
    #[serde(default)]
    pub execution_workspace: Option<PathBuf>,
    #[serde(default)]
    pub execution_workspace_fingerprint: Option<String>,
    pub status: String,
    pub started_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub recovery_note: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WorkflowResumeInput {
    pub checkpoint: WorkflowCheckpoint,
    /// Failed/skipped nodes are retried only when the user explicitly confirms it.
    pub retry_failed_nodes: bool,
    /// Unfinished nodes may have performed external side effects before interruption.
    pub confirm_rerun_unfinished: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WorkflowResumeAssessment {
    pub run_id: Uuid,
    pub can_resume: bool,
    pub stored_fingerprint: Option<String>,
    pub current_fingerprint: Option<String>,
    pub execution_workspace_matches: bool,
    pub successful_nodes: Vec<String>,
    pub retryable_nodes: Vec<String>,
    pub warnings: Vec<String>,
}

/// Fingerprints a Git workspace without reading credentials or environment files beyond
/// what Git itself includes in the working-tree diff. Untracked file contents are included.
pub async fn workspace_fingerprint(repository: &Path) -> Result<String, RunnerError> {
    if !repository.is_absolute() || !repository.is_dir() {
        return Err(RunnerError::InvalidRepository);
    }
    let head = git_output(repository, &["rev-parse", "HEAD"]).await?;
    let status = git_output(repository, &["status", "--porcelain=v1", "-z"]).await?;
    let diff = git_output(repository, &["diff", "--binary", "HEAD"]).await?;
    let untracked = git_output(
        repository,
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )
    .await?;
    let mut hasher = Fnv64::default();
    hasher.write(head.as_bytes());
    hasher.write(status.as_bytes());
    hasher.write(diff.as_bytes());
    for raw in untracked.split('\0').filter(|value| !value.is_empty()) {
        let candidate = repository.join(raw);
        let canonical_root = tokio::fs::canonicalize(repository).await.map_err(|e| {
            RunnerError::Invalid(format!("não foi possível resolver workspace: {e}"))
        })?;
        let canonical_file = tokio::fs::canonicalize(&candidate).await.map_err(|e| {
            RunnerError::Invalid(format!(
                "não foi possível inspecionar arquivo não rastreado: {e}"
            ))
        })?;
        if !canonical_file.starts_with(&canonical_root) {
            return Err(RunnerError::Invalid(
                "arquivo não rastreado aponta para fora do workspace; recuperação bloqueada".into(),
            ));
        }
        let metadata = tokio::fs::metadata(&canonical_file)
            .await
            .map_err(|e| RunnerError::Invalid(e.to_string()))?;
        if metadata.len() > 20 * 1024 * 1024 {
            return Err(RunnerError::Invalid(
                "arquivo não rastreado maior que 20 MiB; fingerprint bloqueado por segurança"
                    .into(),
            ));
        }
        let contents = tokio::fs::read(&canonical_file)
            .await
            .map_err(|e| RunnerError::Invalid(e.to_string()))?;
        hasher.write(raw.as_bytes());
        hasher.write(&contents);
    }
    Ok(format!("fnv1a64:{:016x}", hasher.finish()))
}

async fn ensure_clean_repository(repository: &Path) -> Result<(), RunnerError> {
    let status = git_output(repository, &["status", "--porcelain=v1", "-z"]).await?;
    if !status.is_empty() {
        return Err(RunnerError::Invalid("o workspace possui alterações não commitadas. Worktrees isolados são criados a partir de HEAD e não recebem alterações locais; faça commit/stash ou configure os nós como workspace compartilhado".into()));
    }
    Ok(())
}

async fn git_output(repository: &Path, args: &[&str]) -> Result<String, RunnerError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(args)
        .output()
        .await
        .map_err(|e| {
            RunnerError::Invalid(format!(
                "Git não disponível para validar a recuperação: {e}"
            ))
        })?;
    if !output.status.success() {
        return Err(RunnerError::Invalid(format!(
            "não foi possível verificar o workspace com git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[derive(Default)]
struct Fnv64(u64);
impl Hasher for Fnv64 {
    fn finish(&self) -> u64 {
        if self.0 == 0 {
            0xcbf29ce484222325
        } else {
            self.0
        }
    }
    fn write(&mut self, bytes: &[u8]) {
        let mut hash = if self.0 == 0 {
            0xcbf29ce484222325
        } else {
            self.0
        };
        for byte in bytes {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        self.0 = hash;
    }
}

pub async fn assess_workflow_resume(checkpoint: &WorkflowCheckpoint) -> WorkflowResumeAssessment {
    let mut warnings = Vec::new();
    let current = match workspace_fingerprint(&checkpoint.repository).await {
        Ok(value) => Some(value),
        Err(error) => {
            warnings.push(error.to_string());
            None
        }
    };
    let stored = checkpoint.repository_fingerprint.clone();
    if stored.is_none() {
        warnings.push("Checkpoint anterior à verificação de integridade; não é seguro retomar automaticamente.".into());
    }
    warnings.push("Arquivos ignorados pelo Git (por exemplo, .env, caches e configurações locais) não entram no fingerprint. Revise esses arquivos antes de retomar; não os adicione ao Git apenas para obter uma verificação.".into());
    let workspace_matches = stored
        .as_ref()
        .zip(current.as_ref())
        .map(|(a, b)| a == b)
        .unwrap_or(false);
    if !workspace_matches && stored.is_some() {
        warnings.push("O workspace mudou desde o checkpoint. Faça uma cópia/commit e revise o diff antes de iniciar outro fluxo.".into());
    }
    if !matches!(
        checkpoint.status.as_str(),
        "interrupted" | "cancelled" | "failed"
    ) {
        warnings.push(format!(
            "Estado '{}' não permite retomada.",
            checkpoint.status
        ));
    }
    let has_isolated_nodes = checkpoint
        .workflow
        .nodes
        .iter()
        .any(|node| node.worktree_mode == WorktreeMode::Isolated);
    let execution_workspace_matches = match (
        &checkpoint.execution_workspace,
        &checkpoint.execution_workspace_fingerprint,
    ) {
        (Some(path), Some(expected)) => match workspace_fingerprint(path).await {
            Ok(actual) if &actual == expected => true,
            Ok(_) => {
                warnings.push(
                    "O worktree de execução mudou desde o checkpoint; retomada bloqueada.".into(),
                );
                false
            }
            Err(error) => {
                warnings.push(format!("Worktree de execução indisponível: {error}"));
                false
            }
        },
        (None, _) if !has_isolated_nodes => true,
        _ => {
            warnings.push("Checkpoint não identifica um worktree isolado recuperável. Confira os resultados e inicie um novo workflow em vez de presumir que as alterações anteriores estão presentes.".into());
            false
        }
    };
    let successful_nodes = checkpoint
        .completed_nodes
        .iter()
        .filter(|node| node.status == "succeeded")
        .map(|node| node.node_id.clone())
        .collect();
    let retryable_nodes = checkpoint
        .completed_nodes
        .iter()
        .filter(|node| node.status != "succeeded")
        .map(|node| node.node_id.clone())
        .collect();
    let status_allows_resume = matches!(
        checkpoint.status.as_str(),
        "interrupted" | "cancelled" | "failed"
    );
    if !status_allows_resume {
        warnings.push(format!(
            "Estado '{}' não permite retomada.",
            checkpoint.status
        ));
    }
    WorkflowResumeAssessment {
        run_id: checkpoint.run_id,
        can_resume: workspace_matches && execution_workspace_matches && status_allows_resume,
        stored_fingerprint: stored,
        current_fingerprint: current,
        execution_workspace_matches,
        successful_nodes,
        retryable_nodes,
        warnings,
    }
}

#[derive(Clone)]
pub struct WorkflowCheckpointStore {
    directory: Arc<PathBuf>,
    lock: Arc<Mutex<()>>,
}

impl WorkflowCheckpointStore {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory: Arc::new(directory),
            lock: Arc::new(Mutex::new(())),
        }
    }
    pub async fn save(&self, checkpoint: &WorkflowCheckpoint) -> Result<(), std::io::Error> {
        let _guard = self.lock.lock().await;
        tokio::fs::create_dir_all(self.directory.as_path()).await?;
        let path = self.directory.join(format!("{}.json", checkpoint.run_id));
        let temp = self
            .directory
            .join(format!("{}.{}.tmp", checkpoint.run_id, Uuid::new_v4()));
        let bytes = serde_json::to_vec_pretty(checkpoint).map_err(std::io::Error::other)?;
        tokio::fs::write(&temp, bytes).await?;
        if tokio::fs::metadata(&path).await.is_ok() {
            let backup =
                self.directory
                    .join(format!("{}.{}.bak", checkpoint.run_id, Uuid::new_v4()));
            tokio::fs::rename(&path, &backup).await?;
            match tokio::fs::rename(&temp, &path).await {
                Ok(()) => {
                    let _ = tokio::fs::remove_file(backup).await;
                    Ok(())
                }
                Err(error) => {
                    let _ = tokio::fs::rename(&backup, &path).await;
                    let _ = tokio::fs::remove_file(&temp).await;
                    Err(error)
                }
            }
        } else if let Err(error) = tokio::fs::rename(&temp, &path).await {
            let _ = tokio::fs::remove_file(&temp).await;
            Err(error)
        } else {
            Ok(())
        }
    }
    pub async fn list(&self) -> Result<Vec<WorkflowCheckpoint>, std::io::Error> {
        let _guard = self.lock.lock().await;
        let mut output = Vec::new();
        let mut entries = match tokio::fs::read_dir(self.directory.as_path()).await {
            Ok(value) => value,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(output),
            Err(e) => return Err(e),
        };
        while let Some(entry) = entries.next_entry().await? {
            if entry.path().extension().and_then(|v| v.to_str()) != Some("json") {
                continue;
            }
            let bytes = tokio::fs::read(entry.path()).await?;
            let mut item =
                serde_json::from_slice::<WorkflowCheckpoint>(&bytes).map_err(|error| {
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        format!("checkpoint inválido {}: {error}", entry.path().display()),
                    )
                })?;
            if matches!(item.status.as_str(), "running" | "queued")
                && item.process_id != std::process::id()
            {
                item.status = "interrupted".into();
                item.recovery_note = Some("Host reiniciado ou processo encerrado antes da conclusão. Confira os worktrees e resultados antes de retomar.".into());
            }
            output.push(item);
        }
        output.sort_by_key(|a| std::cmp::Reverse(a.updated_at));
        Ok(output)
    }
}

#[derive(Clone)]
pub struct WorkflowRunner {
    processes: ProcessManager,
    workspaces: WorkspaceManager,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WorkflowProgressEvent {
    pub run_id: Uuid,
    pub workflow_id: Uuid,
    pub node_id: Option<String>,
    pub event: String,
    pub status: String,
    pub at: DateTime<Utc>,
}

impl WorkflowRunner {
    pub fn new(processes: ProcessManager, workspaces: WorkspaceManager) -> Self {
        Self {
            processes,
            workspaces,
        }
    }

    pub async fn run(&self, request: WorkflowRunRequest) -> Result<WorkflowRunResult, RunnerError> {
        let (_cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        let (event_tx, _event_rx) = tokio::sync::mpsc::unbounded_channel();
        self.run_controlled(request, cancel_rx, event_tx).await
    }

    pub async fn run_controlled(
        &self,
        request: WorkflowRunRequest,
        mut cancel_rx: tokio::sync::watch::Receiver<bool>,
        event_tx: tokio::sync::mpsc::UnboundedSender<WorkflowProgressEvent>,
    ) -> Result<WorkflowRunResult, RunnerError> {
        let validation = validate_workflow(&request.workflow);
        if !validation.valid {
            return Err(RunnerError::Invalid(validation.errors.join(" ")));
        }
        if !request.repository.is_absolute() || !request.repository.is_dir() {
            return Err(RunnerError::InvalidRepository);
        }
        validate_policy(&request.workflow, &request.policy)?;
        if request
            .workflow
            .nodes
            .iter()
            .any(|node| node.worktree_mode == WorktreeMode::Isolated)
        {
            ensure_clean_repository(&request.repository).await?;
        }
        let started_at = Utc::now();
        let run_id = request.run_id.unwrap_or_else(Uuid::new_v4);
        let mut seed_results: HashMap<String, WorkflowNodeResult> = HashMap::new();
        let (
            resumed_from,
            prior_fingerprint,
            prior_execution_workspace,
            prior_execution_fingerprint,
        ) = if let Some(resume) = request.resume.as_ref() {
            if !resume.confirm_rerun_unfinished {
                return Err(RunnerError::InvalidPolicy("retomada exige confirmação explícita de que nós sem resultado podem ser executados novamente".into()));
            }
            if resume.checkpoint.workflow.id != request.workflow.id {
                return Err(RunnerError::Invalid(
                    "checkpoint pertence a outro workflow".into(),
                ));
            }
            if resume.checkpoint.repository.canonicalize().ok()
                != request.repository.canonicalize().ok()
            {
                return Err(RunnerError::Invalid(
                    "workspace do checkpoint não corresponde ao workspace solicitado".into(),
                ));
            }
            let assessment = assess_workflow_resume(&resume.checkpoint).await;
            if !assessment.can_resume {
                return Err(RunnerError::Invalid(format!(
                    "retomada bloqueada: {}",
                    assessment.warnings.join(" ")
                )));
            }
            for result in &resume.checkpoint.completed_nodes {
                if result.status == "succeeded" || !resume.retry_failed_nodes {
                    seed_results.insert(result.node_id.clone(), result.clone());
                }
            }
            if let Some(path) = resume.checkpoint.execution_workspace.as_ref() {
                let managed = self.workspaces.list().await.map_err(|e| {
                    RunnerError::Invalid(format!(
                        "não foi possível verificar worktrees gerenciados: {e}"
                    ))
                })?;
                let canonical = path.canonicalize().ok();
                if canonical.is_none()
                    || !managed
                        .iter()
                        .any(|item| item.present && item.path.canonicalize().ok() == canonical)
                {
                    return Err(RunnerError::Invalid("worktree do checkpoint não pertence ao registro gerenciado pelo Orchestrator".into()));
                }
            }
            (
                Some(resume.checkpoint.run_id),
                assessment.stored_fingerprint,
                resume.checkpoint.execution_workspace.clone(),
                resume.checkpoint.execution_workspace_fingerprint.clone(),
            )
        } else {
            (None, None, None, None)
        };
        let fingerprint = match prior_fingerprint {
            Some(value) => Some(value),
            None if request.checkpoint_path.is_some() || request.resume.is_some() => {
                Some(workspace_fingerprint(&request.repository).await?)
            }
            None => None,
        };
        let levels_are_sequential = validation
            .execution_levels
            .iter()
            .all(|level| level.len() <= 1);
        let all_nodes_isolated = request
            .workflow
            .nodes
            .iter()
            .all(|node| node.worktree_mode == WorktreeMode::Isolated);
        let execution_workspace = if let Some(path) = prior_execution_workspace {
            Some(path)
        } else if levels_are_sequential && all_nodes_isolated {
            let safe_workflow = run_id.simple().to_string();
            let worktree = self
                .workspaces
                .create(CreateWorktreeRequest {
                    repository: request.repository.clone(),
                    name: format!(
                        "Workflow {} (workspace compartilhado)",
                        request.workflow.name
                    ),
                    branch_name: format!("psylium/{}/team", &safe_workflow[..8]),
                    base_ref: "HEAD".into(),
                })
                .await
                .map_err(|e| {
                    RunnerError::Invalid(format!(
                        "não foi possível criar worktree compartilhado do workflow: {e}"
                    ))
                })?;
            Some(worktree.path)
        } else {
            None
        };
        let execution_fingerprint =
            match (execution_workspace.as_ref(), prior_execution_fingerprint) {
                (Some(_path), Some(value)) => Some(value),
                (Some(path), None) => Some(workspace_fingerprint(path).await?),
                (None, _) => None,
            };
        let mut checkpoint = WorkflowCheckpoint {
            run_id,
            resumed_from,
            process_id: std::process::id(),
            workflow: request.workflow.clone(),
            repository: request.repository.clone(),
            initial_prompt: request.initial_prompt.clone(),
            policy: request.policy.clone(),
            completed_nodes: seed_results.values().cloned().collect(),
            repository_fingerprint: fingerprint,
            execution_workspace: execution_workspace.clone(),
            execution_workspace_fingerprint: execution_fingerprint,
            status: "running".into(),
            started_at,
            updated_at: Utc::now(),
            recovery_note: None,
        };
        let checkpoint_store = request
            .checkpoint_path
            .clone()
            .map(WorkflowCheckpointStore::new);
        if let Some(store) = &checkpoint_store {
            store.save(&checkpoint).await.map_err(|e| {
                RunnerError::Invalid(format!("não foi possível gravar checkpoint inicial: {e}"))
            })?;
        }
        let _ = event_tx.send(WorkflowProgressEvent {
            run_id,
            workflow_id: request.workflow.id,
            node_id: None,
            event: "started".into(),
            status: "running".into(),
            at: Utc::now(),
        });
        let nodes: HashMap<String, AgentNode> = request
            .workflow
            .nodes
            .iter()
            .cloned()
            .map(|n| (n.id.clone(), n))
            .collect();
        let mut results: HashMap<String, WorkflowNodeResult> = seed_results;
        let edges = request.workflow.edges.clone();
        let deadline = tokio::time::Instant::now()
            + Duration::from_secs(request.policy.max_total_runtime_seconds);
        let active_tasks = Arc::new(Mutex::new(HashSet::<TaskId>::new()));

        for level in validation.execution_levels {
            if tokio::time::Instant::now() >= deadline {
                checkpoint.status = "failed".into();
                checkpoint.updated_at = Utc::now();
                checkpoint.recovery_note =
                    Some("Limite total de execução excedido antes da próxima etapa.".into());
                if let Some(path) = checkpoint.execution_workspace.as_ref() {
                    checkpoint.execution_workspace_fingerprint =
                        workspace_fingerprint(path).await.ok();
                }
                if let Some(store) = &checkpoint_store {
                    let _ = store.save(&checkpoint).await;
                }
                return Err(RunnerError::InvalidPolicy(
                    "limite total de execução excedido antes da próxima etapa".into(),
                ));
            }
            let mut join = JoinSet::new();
            for node_id in level {
                if results
                    .get(&node_id)
                    .map(|item| item.status == "succeeded")
                    .unwrap_or(false)
                {
                    continue;
                }
                if results.contains_key(&node_id)
                    && request
                        .resume
                        .as_ref()
                        .map(|resume| !resume.retry_failed_nodes)
                        .unwrap_or(true)
                {
                    continue;
                }
                results.remove(&node_id);
                let node = nodes
                    .get(&node_id)
                    .cloned()
                    .ok_or_else(|| RunnerError::Invalid(format!("nó ausente: {node_id}")))?;
                let failed_dependency = edges
                    .iter()
                    .filter(|edge| edge.target == node_id)
                    .filter_map(|edge| results.get(&edge.source))
                    .any(|result| result.status != "succeeded");
                if failed_dependency {
                    let now = Utc::now();
                    results.insert(
                        node_id.clone(),
                        WorkflowNodeResult {
                            node_id,
                            task_id: None,
                            status: "skipped_dependency_failed".into(),
                            output: String::new(),
                            error: Some(
                                "Um predecessor falhou; execução deste nó foi bloqueada.".into(),
                            ),
                            started_at: now,
                            finished_at: now,
                        },
                    );
                    continue;
                }
                let context = build_context(&node, &edges, &results, &request.initial_prompt);
                let manager = self.processes.clone();
                let workspaces = self.workspaces.clone();
                let repository = request.repository.clone();
                let workflow_id = run_id;
                let node_timeout = Duration::from_secs(request.policy.max_node_runtime_seconds);
                let output_limit = request
                    .policy
                    .max_output_bytes
                    .clamp(1024, MAX_NODE_OUTPUT_BYTES);
                let active_tasks = active_tasks.clone();
                let progress = event_tx.clone();
                let node_id_for_event = node.id.clone();
                let _ = progress.send(WorkflowProgressEvent {
                    run_id,
                    workflow_id: request.workflow.id,
                    node_id: Some(node_id_for_event.clone()),
                    event: "node_started".into(),
                    status: "running".into(),
                    at: Utc::now(),
                });
                let shared_worktree = execution_workspace.clone();
                join.spawn(async move {
                    let node_id = node.id.clone();
                    (
                        node_id,
                        execute_node(
                            manager,
                            workspaces,
                            node,
                            repository,
                            workflow_id,
                            shared_worktree,
                            context,
                            node_timeout,
                            output_limit,
                            active_tasks,
                        )
                        .await,
                    )
                });
            }
            while !join.is_empty() {
                if tokio::time::Instant::now() >= deadline {
                    let ids: Vec<_> = active_tasks.lock().await.iter().copied().collect();
                    for id in ids {
                        let _ = self.processes.cancel(id).await;
                    }
                    join.abort_all();
                    checkpoint.completed_nodes = results.values().cloned().collect();
                    checkpoint.status = "failed".into();
                    checkpoint.updated_at = Utc::now();
                    checkpoint.recovery_note = Some("Limite total excedido; tarefas restantes foram canceladas. Resultados concluídos foram preservados.".into());
                    if let Some(path) = checkpoint.execution_workspace.as_ref() {
                        checkpoint.execution_workspace_fingerprint =
                            workspace_fingerprint(path).await.ok();
                    }
                    if let Some(store) = &checkpoint_store {
                        let _ = store.save(&checkpoint).await;
                    }
                    return Err(RunnerError::InvalidPolicy(
                        "limite total de execução excedido; tarefas restantes foram canceladas"
                            .into(),
                    ));
                }
                let joined = tokio::select! {
                    changed = cancel_rx.changed() => {
                        if changed.is_ok() && *cancel_rx.borrow() {
                            let ids: Vec<_> = active_tasks.lock().await.iter().copied().collect();
                            for id in ids { let _ = self.processes.cancel(id).await; }
                            join.abort_all();
                            checkpoint.status = "cancelled".into(); checkpoint.updated_at = Utc::now(); checkpoint.recovery_note = Some("Execução cancelada pelo usuário. Resultados concluídos foram preservados.".into());
                            checkpoint.completed_nodes = results.values().cloned().collect();
                            if let Some(path) = checkpoint.execution_workspace.as_ref() { checkpoint.execution_workspace_fingerprint = workspace_fingerprint(path).await.ok(); }
                            if let Some(store) = &checkpoint_store { let _ = store.save(&checkpoint).await; }
                            let _ = event_tx.send(WorkflowProgressEvent { run_id, workflow_id: request.workflow.id, node_id: None, event: "cancelled".into(), status: "cancelled".into(), at: Utc::now() });
                            return Err(RunnerError::Cancelled);
                        }
                        continue;
                    }
                    value = tokio::time::timeout_at(deadline, join.join_next()) => match value {
                        Ok(Some(value)) => value,
                        Ok(None) => return Err(RunnerError::Invalid("executor encerrou sem resultado".into())),
                        Err(_) => {
                            let ids: Vec<_> = active_tasks.lock().await.iter().copied().collect();
                            for id in ids { let _ = self.processes.cancel(id).await; }
                            join.abort_all();
                            checkpoint.completed_nodes = results.values().cloned().collect(); checkpoint.status = "failed".into(); checkpoint.updated_at = Utc::now(); checkpoint.recovery_note = Some("Limite total excedido; tarefas restantes foram canceladas. Resultados concluídos foram preservados.".into());
                            if let Some(path) = checkpoint.execution_workspace.as_ref() { checkpoint.execution_workspace_fingerprint = workspace_fingerprint(path).await.ok(); }
                            if let Some(store) = &checkpoint_store { let _ = store.save(&checkpoint).await; }
                            return Err(RunnerError::InvalidPolicy("limite total de execução excedido; tarefas restantes foram canceladas".into()));
                        }
                    }
                };
                let (node_id, execution) = joined
                    .map_err(|e| RunnerError::Invalid(format!("falha interna do executor: {e}")))?;
                let result = match execution {
                    Ok(result) => result,
                    Err(error) => {
                        let now = Utc::now();
                        WorkflowNodeResult {
                            node_id: node_id.clone(),
                            task_id: None,
                            status: "failed".into(),
                            output: String::new(),
                            error: Some(error.to_string()),
                            started_at: now,
                            finished_at: now,
                        }
                    }
                };
                let _ = event_tx.send(WorkflowProgressEvent {
                    run_id,
                    workflow_id: request.workflow.id,
                    node_id: Some(node_id.clone()),
                    event: "node_finished".into(),
                    status: result.status.clone(),
                    at: Utc::now(),
                });
                results.insert(node_id, result);
                checkpoint.completed_nodes = results.values().cloned().collect();
                if let Some(path) = checkpoint.execution_workspace.as_ref() {
                    checkpoint.execution_workspace_fingerprint =
                        Some(workspace_fingerprint(path).await?);
                }
                checkpoint.updated_at = Utc::now();
                if let Some(store) = &checkpoint_store {
                    store.save(&checkpoint).await.map_err(|e| {
                        RunnerError::Invalid(format!("falha ao persistir checkpoint: {e}"))
                    })?;
                }
            }
        }

        let mut ordered: Vec<_> = request
            .workflow
            .nodes
            .iter()
            .filter_map(|n| results.remove(&n.id))
            .collect();
        ordered.sort_by_key(|r| {
            request
                .workflow
                .nodes
                .iter()
                .position(|n| n.id == r.node_id)
                .unwrap_or(usize::MAX)
        });
        let failed = ordered.iter().any(|r| r.status != "succeeded");
        let status = if failed { "failed" } else { "succeeded" };
        let _ = event_tx.send(WorkflowProgressEvent {
            run_id,
            workflow_id: request.workflow.id,
            node_id: None,
            event: "finished".into(),
            status: status.into(),
            at: Utc::now(),
        });
        checkpoint.completed_nodes = ordered.clone();
        checkpoint.status = status.into();
        checkpoint.updated_at = Utc::now();
        checkpoint.recovery_note = None;
        if let Some(path) = checkpoint.execution_workspace.as_ref() {
            checkpoint.execution_workspace_fingerprint = Some(workspace_fingerprint(path).await?);
        }
        if let Some(store) = &checkpoint_store {
            store
                .save(&checkpoint)
                .await
                .map_err(|e| RunnerError::Invalid(format!("falha ao finalizar checkpoint: {e}")))?;
        }
        Ok(WorkflowRunResult {
            run_id,
            workflow_id: request.workflow.id,
            status: status.into(),
            nodes: ordered,
            started_at,
            finished_at: Utc::now(),
        })
    }
}

fn validate_policy(
    workflow: &WorkflowDefinition,
    policy: &WorkflowRunPolicy,
) -> Result<(), RunnerError> {
    if policy.max_nodes == 0 || workflow.nodes.len() > policy.max_nodes {
        return Err(RunnerError::InvalidPolicy(format!(
            "workflow possui {} nós; limite configurado: {}",
            workflow.nodes.len(),
            policy.max_nodes
        )));
    }
    if policy.max_node_runtime_seconds == 0 || policy.max_total_runtime_seconds == 0 {
        return Err(RunnerError::InvalidPolicy(
            "limites de tempo devem ser maiores que zero".into(),
        ));
    }
    if policy.max_output_bytes < 1024 {
        return Err(RunnerError::InvalidPolicy(
            "limite de saída deve ser de pelo menos 1 KiB".into(),
        ));
    }
    if policy.require_review_node {
        let reviewer = workflow
            .nodes
            .iter()
            .find(|node| {
                let role = node.role.to_ascii_lowercase();
                let name = node.name.to_ascii_lowercase();
                role.contains("review")
                    || role.contains("revis")
                    || name.contains("review")
                    || name.contains("revis")
            })
            .ok_or_else(|| {
                RunnerError::InvalidPolicy(
                    "a política exige um nó dedicado de revisão (review/revisão)".into(),
                )
            })?;
        let mut ancestors = HashSet::new();
        let mut pending = vec![reviewer.id.clone()];
        while let Some(target) = pending.pop() {
            for edge in workflow.edges.iter().filter(|edge| edge.target == target) {
                if ancestors.insert(edge.source.clone()) {
                    pending.push(edge.source.clone());
                }
            }
        }
        if workflow
            .nodes
            .iter()
            .filter(|node| node.id != reviewer.id)
            .any(|node| !ancestors.contains(&node.id))
        {
            return Err(RunnerError::InvalidPolicy("o nó de revisão precisa receber dependências de todos os demais agentes; conecte-os ao revisor direta ou indiretamente".into()));
        }
    }
    Ok(())
}

fn build_context(
    node: &AgentNode,
    edges: &[WorkflowEdge],
    results: &HashMap<String, WorkflowNodeResult>,
    initial: &str,
) -> String {
    let mut sections = vec![format!("Objetivo original:\n{}", initial)];
    for edge in edges
        .iter()
        .filter(|e| e.target == node.id && e.pass_context)
    {
        if let Some(result) = results.get(&edge.source) {
            let content = match node.context_mode {
                ContextMode::None => String::new(),
                ContextMode::Summary | ContextMode::FullOutput => result.output.clone(),
                ContextMode::FilesOnly => result
                    .output
                    .lines()
                    .filter(|line| {
                        line.contains("file") || line.contains("arquivo") || line.contains("/")
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
            };
            if !content.is_empty() {
                sections.push(format!(
                    "Resultado do agente {} ({}):\n{}",
                    edge.source, result.status, content
                ));
            }
        }
    }
    let mut context = sections.join("\n\n---\n\n");
    if context.len() > MAX_CONTEXT_BYTES {
        context.truncate(MAX_CONTEXT_BYTES);
        context.push_str("\n[Contexto truncado pelo limite de segurança]");
    }
    context
}

#[allow(clippy::too_many_arguments)]
async fn execute_node(
    manager: ProcessManager,
    workspaces: WorkspaceManager,
    node: AgentNode,
    repository: PathBuf,
    workflow_id: Uuid,
    shared_worktree: Option<PathBuf>,
    context: String,
    node_timeout: Duration,
    output_limit: usize,
    active_tasks: Arc<Mutex<HashSet<TaskId>>>,
) -> Result<WorkflowNodeResult, RunnerError> {
    let started_at = Utc::now();
    let prompt = format!(
        "Papel: {}\n\nInstruções do agente:\n{}\n\nContexto recebido:\n{}",
        node.role, node.prompt, context
    );
    let cwd = if node.worktree_mode == WorktreeMode::Isolated {
        if let Some(shared_path) = shared_worktree {
            shared_path
        } else {
            let safe_node = node
                .id
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '-' {
                        c
                    } else {
                        '-'
                    }
                })
                .collect::<String>();
            let branch_name = format!(
                "psylium/{}/{}",
                &workflow_id.simple().to_string()[..8],
                safe_node
            );
            workspaces
                .create(CreateWorktreeRequest {
                    repository: repository.clone(),
                    name: format!("{} - {}", workflow_id, node.name),
                    branch_name,
                    base_ref: "HEAD".into(),
                })
                .await
                .map_err(|e| RunnerError::Node {
                    node: node.id.clone(),
                    message: format!("não foi possível criar worktree isolado: {e}"),
                })?
                .path
        }
    } else {
        repository
    };
    let request = AgentLaunchRequest {
        provider: node.provider,
        prompt,
        cwd,
        model: node.model.clone(),
        effort: node.effort.clone(),
        display_name: Some(node.name.clone()),
    };
    let spec = build_process_spec(request).map_err(|e| RunnerError::Node {
        node: node.id.clone(),
        message: e.to_string(),
    })?;
    let mut events = manager.subscribe();
    let task_id = manager.start(spec).await.map_err(|e| RunnerError::Node {
        node: node.id.clone(),
        message: e.to_string(),
    })?;
    active_tasks.lock().await.insert(task_id);
    let mut output = String::new();
    let deadline = tokio::time::Instant::now() + node_timeout;
    loop {
        if let Ok(event) = events.try_recv() {
            if event.task_id == task_id {
                if let TaskEventPayload::Output { line, .. } = event.payload {
                    if output.len() < output_limit {
                        output.push_str(&line);
                        output.push('\n');
                    }
                }
            }
        }
        if let Some(snapshot) = manager.get_task(task_id).await {
            if snapshot.status.is_terminal() {
                // Drain any final buffered output for this task.
                loop {
                    match events.try_recv() {
                        Ok(event) if event.task_id == task_id => {
                            if let TaskEventPayload::Output { line, .. } = event.payload {
                                if output.len() < output_limit {
                                    output.push_str(&line);
                                    output.push('\n');
                                }
                            }
                        }
                        Ok(_) => continue,
                        Err(_) => break,
                    }
                }
                let status = if snapshot.status == TaskStatus::Succeeded {
                    "succeeded"
                } else {
                    "failed"
                };
                active_tasks.lock().await.remove(&task_id);
                return Ok(WorkflowNodeResult {
                    node_id: node.id,
                    task_id: Some(task_id),
                    status: status.into(),
                    output,
                    error: snapshot.last_error,
                    started_at,
                    finished_at: Utc::now(),
                });
            }
        }
        if tokio::time::Instant::now() >= deadline {
            let _ = manager.cancel(task_id).await;
            active_tasks.lock().await.remove(&task_id);
            return Err(RunnerError::Node {
                node: node.id,
                message: "limite de tempo configurado para este agente excedido".into(),
            });
        }
        tokio::select! { _ = sleep(Duration::from_millis(80)) => {}, event = events.recv() => { if let Ok(event) = event { if event.task_id == task_id { if let TaskEventPayload::Output { line, .. } = event.payload { if output.len() < output_limit { output.push_str(&line); output.push('\n'); } } } } } }
    }
}

#[derive(Clone)]
pub struct WorkflowRunStore {
    path: Arc<PathBuf>,
    lock: Arc<Mutex<()>>,
}

impl WorkflowRunStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path: Arc::new(path),
            lock: Arc::new(Mutex::new(())),
        }
    }

    pub async fn record(&self, result: WorkflowRunResult) -> Result<(), std::io::Error> {
        let _guard = self.lock.lock().await;
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let mut entries = self.read_unlocked().await?;
        entries.retain(|entry| entry.run_id != result.run_id);
        entries.push(result);
        entries.sort_by_key(|a| std::cmp::Reverse(a.started_at));
        entries.truncate(100);
        let temp = self.path.with_extension(format!("{}.tmp", Uuid::new_v4()));
        tokio::fs::write(
            &temp,
            serde_json::to_vec_pretty(&entries).map_err(std::io::Error::other)?,
        )
        .await?;
        if tokio::fs::metadata(self.path.as_path()).await.is_ok() {
            let backup = self.path.with_extension(format!("{}.bak", Uuid::new_v4()));
            tokio::fs::rename(self.path.as_path(), &backup).await?;
            match tokio::fs::rename(&temp, self.path.as_path()).await {
                Ok(()) => {
                    let _ = tokio::fs::remove_file(backup).await;
                }
                Err(error) => {
                    let _ = tokio::fs::rename(&backup, self.path.as_path()).await;
                    let _ = tokio::fs::remove_file(&temp).await;
                    return Err(error);
                }
            }
        } else {
            tokio::fs::rename(&temp, self.path.as_path()).await?;
        }
        Ok(())
    }

    pub async fn list(&self, limit: usize) -> Result<Vec<WorkflowRunResult>, std::io::Error> {
        let _guard = self.lock.lock().await;
        let mut entries = self.read_unlocked().await?;
        entries.truncate(limit.clamp(1, 100));
        Ok(entries)
    }

    async fn read_unlocked(&self) -> Result<Vec<WorkflowRunResult>, std::io::Error> {
        match tokio::fs::read(self.path.as_path()).await {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(std::io::Error::other),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn run_history_persists_and_limits_results() {
        let path =
            std::env::temp_dir().join(format!("orchestrator-run-history-{}.json", Uuid::new_v4()));
        let store = WorkflowRunStore::new(path.clone());
        let now = Utc::now();
        let result = WorkflowRunResult {
            run_id: Uuid::new_v4(),
            workflow_id: Uuid::new_v4(),
            status: "succeeded".into(),
            nodes: vec![],
            started_at: now,
            finished_at: now,
        };
        store.record(result.clone()).await.unwrap();
        let loaded = store.list(10).await.unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].run_id, result.run_id);
        let _ = tokio::fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn checkpoint_store_marks_running_workflows_as_interrupted() {
        let directory =
            std::env::temp_dir().join(format!("orchestrator-checkpoints-{}", Uuid::new_v4()));
        let store = WorkflowCheckpointStore::new(directory.clone());
        let now = Utc::now();
        let workflow = WorkflowDefinition::new("Recoverable", vec![], vec![]);
        let checkpoint = WorkflowCheckpoint {
            run_id: Uuid::new_v4(),
            resumed_from: None,
            process_id: 0,
            workflow,
            repository: std::env::temp_dir(),
            initial_prompt: "continue".into(),
            policy: WorkflowRunPolicy::default(),
            completed_nodes: vec![],
            repository_fingerprint: None,
            execution_workspace: None,
            execution_workspace_fingerprint: None,
            status: "running".into(),
            started_at: now,
            updated_at: now,
            recovery_note: None,
        };
        store.save(&checkpoint).await.unwrap();
        let mut updated = checkpoint.clone();
        updated.updated_at = Utc::now();
        store.save(&updated).await.unwrap();
        let recovered = store.list().await.unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].status, "interrupted");
        assert!(recovered[0].recovery_note.is_some());
        let _ = tokio::fs::remove_dir_all(directory).await;
    }

    #[test]
    fn policy_rejects_workflow_without_review_node() {
        let workflow = WorkflowDefinition::new(
            "No review",
            vec![AgentNode {
                id: "dev".into(),
                name: "Developer".into(),
                role: "Implementação".into(),
                prompt: "build".into(),
                provider: shared_protocol::ProviderId::ClaudeCode,
                model: None,
                effort: None,
                context_mode: ContextMode::Summary,
                worktree_mode: WorktreeMode::Isolated,
                position: workflow_engine::NodePosition { x: 0.0, y: 0.0 },
            }],
            vec![],
        );
        assert!(validate_policy(&workflow, &WorkflowRunPolicy::default()).is_err());
    }

    #[test]
    fn policy_accepts_review_and_rejects_zero_timeout() {
        let workflow = WorkflowDefinition::new(
            "Review",
            vec![AgentNode {
                id: "review".into(),
                name: "Reviewer".into(),
                role: "Revisão".into(),
                prompt: "review".into(),
                provider: shared_protocol::ProviderId::Codex,
                model: None,
                effort: None,
                context_mode: ContextMode::Summary,
                worktree_mode: WorktreeMode::Isolated,
                position: workflow_engine::NodePosition { x: 0.0, y: 0.0 },
            }],
            vec![],
        );
        assert!(validate_policy(&workflow, &WorkflowRunPolicy::default()).is_ok());
        let policy = WorkflowRunPolicy {
            max_total_runtime_seconds: 0,
            ..Default::default()
        };
        assert!(validate_policy(&workflow, &policy).is_err());
    }

    #[tokio::test]
    async fn workspace_fingerprint_detects_tracked_file_changes() {
        let directory =
            std::env::temp_dir().join(format!("orchestrator-fingerprint-{}", Uuid::new_v4()));
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let init = Command::new("git")
            .arg("init")
            .arg(&directory)
            .output()
            .await;
        if init.is_err() || !init.unwrap().status.success() {
            let _ = tokio::fs::remove_dir_all(&directory).await;
            return;
        }
        let _ = Command::new("git")
            .arg("-C")
            .arg(&directory)
            .args(["config", "user.email", "orchestrator-test@example.invalid"])
            .output()
            .await;
        let _ = Command::new("git")
            .arg("-C")
            .arg(&directory)
            .args(["config", "user.name", "Orchestrator Test"])
            .output()
            .await;
        let file = directory.join("sample.txt");
        tokio::fs::write(&file, "initial").await.unwrap();
        assert!(Command::new("git")
            .arg("-C")
            .arg(&directory)
            .args(["add", "sample.txt"])
            .output()
            .await
            .unwrap()
            .status
            .success());
        assert!(Command::new("git")
            .arg("-C")
            .arg(&directory)
            .args(["commit", "-m", "initial"])
            .output()
            .await
            .unwrap()
            .status
            .success());
        let before = workspace_fingerprint(&directory).await.unwrap();
        tokio::fs::write(&file, "changed").await.unwrap();
        let after = workspace_fingerprint(&directory).await.unwrap();
        assert_ne!(before, after);
        let _ = tokio::fs::remove_dir_all(&directory).await;
    }

    #[test]
    fn fingerprint_hash_is_stable_for_identical_bytes() {
        let mut left = Fnv64::default();
        left.write(b"same-workspace");
        let mut right = Fnv64::default();
        right.write(b"same-workspace");
        assert_eq!(left.finish(), right.finish());
    }

    #[tokio::test]
    async fn checkpoint_without_fingerprint_is_never_marked_resumable() {
        let now = Utc::now();
        let checkpoint = WorkflowCheckpoint {
            run_id: Uuid::new_v4(),
            resumed_from: None,
            process_id: 0,
            workflow: WorkflowDefinition::new("Legacy", vec![], vec![]),
            repository: std::env::temp_dir(),
            initial_prompt: "x".into(),
            policy: WorkflowRunPolicy::default(),
            completed_nodes: vec![],
            repository_fingerprint: None,
            execution_workspace: None,
            execution_workspace_fingerprint: None,
            status: "interrupted".into(),
            started_at: now,
            updated_at: now,
            recovery_note: None,
        };
        let assessment = assess_workflow_resume(&checkpoint).await;
        assert!(!assessment.can_resume);
        assert!(assessment
            .warnings
            .iter()
            .any(|warning| warning.contains("integridade")));
    }

    #[test]
    fn caps_context_and_does_not_forward_when_edge_disabled() {
        let node = AgentNode {
            id: "b".into(),
            name: "B".into(),
            role: "reviewer".into(),
            prompt: "review".into(),
            provider: shared_protocol::ProviderId::ClaudeCode,
            model: None,
            effort: None,
            context_mode: ContextMode::Summary,
            worktree_mode: workflow_engine::WorktreeMode::Shared,
            position: workflow_engine::NodePosition { x: 0.0, y: 0.0 },
        };
        let edge = WorkflowEdge {
            id: "e".into(),
            source: "a".into(),
            target: "b".into(),
            pass_context: false,
        };
        let mut results = HashMap::new();
        results.insert(
            "a".into(),
            WorkflowNodeResult {
                node_id: "a".into(),
                task_id: None,
                status: "succeeded".into(),
                output: "secret context".into(),
                error: None,
                started_at: Utc::now(),
                finished_at: Utc::now(),
            },
        );
        let context = build_context(&node, &[edge], &results, "initial");
        assert!(!context.contains("secret context"));
        assert!(context.contains("initial"));
    }
}
