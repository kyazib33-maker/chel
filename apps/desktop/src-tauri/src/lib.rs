mod skills;
use antigravity_adapter::{
    build_process_spec as build_antigravity_spec, default_cache_path, read_workspace_conversation,
    AntigravityRequest,
};
use chrono::Utc;
use claude_code_adapter::{
    ClaudeApprovalBridge, ClaudeCodeManager, ClaudeSessionInfo, ClaudeStartRequest,
};
use codex_app_server::{
    CodexAppServerManager, CodexApprovalBridge, CodexSessionInfo, CodexStartRequest,
};
use orchestrator_intelligence::{
    assess_budget, compile_delegation_blueprint, estimate_cost, AuditEvent, AuditJournal,
    ExecutionBudget, MemoryEntry, MemoryKind, ModelPricing, PricingStore, ProjectMemoryStore,
    TokenUsageInput,
};
use permission_engine::{PermissionEngine, PermissionRequest};
use process_manager::{ProcessManager, ProcessManagerConfig};
use provider_adapters::build_process_spec;
use remote_server::{PairedDevice, PairingInfo, RemoteServerController, RemoteServerInfo};
use serde_json::Value;
use session_manager::{ManagedSession, RecoveryMode, SessionProvider, SessionRegistry};
use shared_protocol::{AgentLaunchRequest, ProviderId, TaskEventPayload, TaskId, TaskSnapshot};
use tauri::{AppHandle, Emitter, Manager, State};
use usage_monitor::{UsageMonitor, UsageSnapshot};
use uuid::Uuid;
use workflow_engine::{
    validate_workflow as validate_workflow_definition, WorkflowDefinition, WorkflowStore,
    WorkflowValidation,
};
use workflow_runner::{
    assess_workflow_resume, WorkflowCheckpoint, WorkflowCheckpointStore, WorkflowProgressEvent,
    WorkflowResumeAssessment, WorkflowResumeInput, WorkflowRunPolicy, WorkflowRunRequest,
    WorkflowRunResult, WorkflowRunStore, WorkflowRunner,
};
use workspace_manager::{CreateWorktreeRequest, WorkspaceManager, WorktreeInfo};

#[tauri::command]
async fn start_claude_session(
    manager: State<'_, ClaudeCodeManager>,
    registry: State<'_, SessionRegistry>,
    request: ClaudeStartRequest,
) -> Result<ClaudeSessionInfo, String> {
    let info = manager
        .start(request)
        .await
        .map_err(|error| error.to_string())?;
    registry.upsert(ManagedSession { id: info.id, provider: SessionProvider::ClaudeCode,
        external_session_id: info.claude_session_id.clone(), cwd: info.cwd.clone(), model: info.model.clone(),
        status: info.status.clone(), recovery_mode: RecoveryMode::NativeResume,
        recovery_note: "Retomada disponível pelo ID nativo do Claude Code; o processo não é restaurado automaticamente.".into(),
        started_at: info.started_at, updated_at: Utc::now(), last_error: None }).await.map_err(|e| e.to_string())?;
    Ok(info)
}

#[tauri::command]
async fn resume_claude_session(
    manager: State<'_, ClaudeCodeManager>,
    registry: State<'_, SessionRegistry>,
    session_id: String,
    prompt: String,
) -> Result<ClaudeSessionInfo, String> {
    let id = Uuid::parse_str(&session_id).map_err(|_| "session_id inválido".to_string())?;
    let previous = registry
        .get(id)
        .await
        .ok_or_else(|| "sessão gerenciada não encontrada".to_string())?;
    if previous.provider != SessionProvider::ClaudeCode {
        return Err("a sessão não pertence ao Claude Code".into());
    }
    let native_id = previous
        .external_session_id
        .clone()
        .ok_or_else(|| "sessão sem ID nativo do Claude Code".to_string())?;
    let info = manager
        .start(ClaudeStartRequest {
            cwd: previous.cwd.clone(),
            prompt,
            model: previous.model.clone(),
            effort: None,
            permission_mode: Some("default".into()),
            resume_session_id: Some(native_id.clone()),
        })
        .await
        .map_err(|e| e.to_string())?;
    registry
        .upsert(ManagedSession {
            id: info.id,
            provider: SessionProvider::ClaudeCode,
            external_session_id: Some(native_id),
            cwd: info.cwd.clone(),
            model: info.model.clone(),
            status: info.status.clone(),
            recovery_mode: RecoveryMode::NativeResume,
            recovery_note: "Sessão retomada pelo ID nativo do Claude Code.".into(),
            started_at: info.started_at,
            updated_at: Utc::now(),
            last_error: None,
        })
        .await
        .map_err(|e| e.to_string())?;
    Ok(info)
}

#[tauri::command]
async fn list_claude_sessions(
    manager: State<'_, ClaudeCodeManager>,
) -> Result<Vec<ClaudeSessionInfo>, String> {
    Ok(manager.list().await)
}

#[tauri::command]
async fn send_claude_message(
    manager: State<'_, ClaudeCodeManager>,
    session_id: String,
    prompt: String,
) -> Result<(), String> {
    let id = Uuid::parse_str(&session_id).map_err(|_| "session_id inválido".to_string())?;
    manager
        .send_user_message(id, prompt)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn stop_claude_session(
    manager: State<'_, ClaudeCodeManager>,
    registry: State<'_, SessionRegistry>,
    session_id: String,
) -> Result<(), String> {
    let id = Uuid::parse_str(&session_id).map_err(|_| "session_id inválido".to_string())?;
    manager.stop(id).await.map_err(|error| error.to_string())?;
    let _ = registry.set_status(id, "stopped", None).await;
    Ok(())
}

#[tauri::command]
async fn start_codex_session(
    manager: State<'_, CodexAppServerManager>,
    registry: State<'_, SessionRegistry>,
    request: CodexStartRequest,
) -> Result<CodexSessionInfo, String> {
    let info = manager
        .start(request)
        .await
        .map_err(|error| error.to_string())?;
    registry
        .upsert(ManagedSession {
            id: info.id,
            provider: SessionProvider::Codex,
            external_session_id: Some(info.thread_id.clone()),
            cwd: info.cwd.clone(),
            model: None,
            status: info.status.clone(),
            recovery_mode: RecoveryMode::NativeResume,
            recovery_note:
                "Thread ID preservado; retomada disponível via thread/resume do App Server.".into(),
            started_at: info.started_at,
            updated_at: Utc::now(),
            last_error: None,
        })
        .await
        .map_err(|e| e.to_string())?;
    Ok(info)
}

#[tauri::command]
async fn resume_codex_session(
    manager: State<'_, CodexAppServerManager>,
    registry: State<'_, SessionRegistry>,
    session_id: String,
    prompt: String,
) -> Result<CodexSessionInfo, String> {
    let id = Uuid::parse_str(&session_id).map_err(|_| "session_id inválido".to_string())?;
    let previous = registry
        .get(id)
        .await
        .ok_or_else(|| "sessão gerenciada não encontrada".to_string())?;
    if previous.provider != SessionProvider::Codex {
        return Err("a sessão não pertence ao Codex".into());
    }
    let thread_id = previous
        .external_session_id
        .clone()
        .ok_or_else(|| "sessão sem thread ID do Codex".to_string())?;
    let info = manager
        .start(CodexStartRequest {
            cwd: previous.cwd.clone(),
            prompt,
            model: previous.model.clone(),
            sandbox: Some("workspace-write".into()),
            persistent: Some(true),
            resume_thread_id: Some(thread_id.clone()),
        })
        .await
        .map_err(|e| e.to_string())?;
    registry
        .upsert(ManagedSession {
            id: info.id,
            provider: SessionProvider::Codex,
            external_session_id: Some(thread_id),
            cwd: info.cwd.clone(),
            model: previous.model.clone(),
            status: info.status.clone(),
            recovery_mode: RecoveryMode::NativeResume,
            recovery_note: "Thread retomada por thread/resume do Codex App Server.".into(),
            started_at: info.started_at,
            updated_at: Utc::now(),
            last_error: None,
        })
        .await
        .map_err(|e| e.to_string())?;
    Ok(info)
}

#[tauri::command]
async fn list_codex_sessions(
    manager: State<'_, CodexAppServerManager>,
) -> Result<Vec<CodexSessionInfo>, String> {
    Ok(manager.list().await)
}

#[tauri::command]
async fn respond_codex_approval(
    manager: State<'_, CodexAppServerManager>,
    session_id: String,
    request_id: Value,
    decision: String,
) -> Result<(), String> {
    let session_id = Uuid::parse_str(&session_id).map_err(|_| "session_id inválido".to_string())?;
    manager
        .approve(session_id, request_id, &decision)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn stop_codex_session(
    manager: State<'_, CodexAppServerManager>,
    registry: State<'_, SessionRegistry>,
    session_id: String,
) -> Result<(), String> {
    let session_id = Uuid::parse_str(&session_id).map_err(|_| "session_id inválido".to_string())?;
    manager
        .stop(session_id)
        .await
        .map_err(|error| error.to_string())?;
    let _ = registry.set_status(session_id, "stopped", None).await;
    Ok(())
}

#[tauri::command]
async fn import_antigravity_workspace_session(
    registry: State<'_, SessionRegistry>,
    cwd: std::path::PathBuf,
) -> Result<ManagedSession, String> {
    if !cwd.is_absolute() || !cwd.is_dir() {
        return Err("diretório de trabalho inválido".into());
    }
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
        .ok_or_else(|| "diretório HOME não encontrado".to_string())?;
    let native_id = read_workspace_conversation(default_cache_path(home), &cwd)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "nenhuma conversa Antigravity encontrada para este workspace".to_string())?;
    if let Some(existing) = registry.list().await.into_iter().find(|item| {
        item.provider == SessionProvider::Antigravity
            && item.cwd == cwd
            && item.external_session_id.as_deref() == Some(native_id.as_str())
    }) {
        return Ok(existing);
    }
    let now = Utc::now();
    let record = ManagedSession {
        id: Uuid::new_v4(),
        provider: SessionProvider::Antigravity,
        external_session_id: Some(native_id),
        cwd,
        model: None,
        status: "interrupted".into(),
        recovery_mode: RecoveryMode::NativeResume,
        recovery_note:
            "Conversa importada do cache oficial do Antigravity. Pode ser retomada pelo ID nativo."
                .into(),
        started_at: now,
        updated_at: now,
        last_error: None,
    };
    registry.upsert(record).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn resume_antigravity_session(
    manager: State<'_, ProcessManager>,
    registry: State<'_, SessionRegistry>,
    session_id: String,
    prompt: String,
) -> Result<String, String> {
    let id = Uuid::parse_str(&session_id).map_err(|_| "session_id inválido".to_string())?;
    let previous = registry
        .get(id)
        .await
        .ok_or_else(|| "sessão gerenciada não encontrada".to_string())?;
    if previous.provider != SessionProvider::Antigravity {
        return Err("a sessão não pertence ao Antigravity".into());
    }
    if matches!(previous.status.as_str(), "running" | "starting") {
        return Err("esta sessão já possui uma execução em andamento".into());
    }
    let native_id = previous
        .external_session_id
        .clone()
        .ok_or_else(|| "sessão sem conversation ID do Antigravity".to_string())?;
    let spec = build_antigravity_spec(AntigravityRequest {
        cwd: previous.cwd.clone(),
        prompt,
        model: previous.model.clone(),
        effort: None,
        mode: None,
        conversation_id: Some(native_id),
    })
    .map_err(|e| e.to_string())?;
    let mut events = manager.subscribe();
    let task_id = manager.start(spec).await.map_err(|e| e.to_string())?;
    registry
        .set_status(id, "running", None)
        .await
        .map_err(|e| e.to_string())?;
    let registry = registry.inner().clone();
    let mut record = previous;
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from);
    tauri::async_runtime::spawn(async move {
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
                        let _ = registry.upsert(record).await;
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                _ => {}
            }
        }
    });
    Ok(task_id.to_string())
}

#[tauri::command]
async fn list_provider_capabilities() -> Vec<provider_runtime::ProviderCapabilities> {
    provider_runtime::catalog()
}

#[tauri::command]
async fn list_managed_sessions(
    registry: State<'_, SessionRegistry>,
) -> Result<Vec<ManagedSession>, String> {
    Ok(registry.list().await)
}

fn project_memory_scope(project_path: Option<String>) -> Result<String, String> {
    match project_path {
        None => Ok("global".into()),
        Some(raw) => {
            let path = std::path::PathBuf::from(raw);
            if !path.is_absolute() {
                return Err("caminho do projeto deve ser absoluto".into());
            }
            let canonical = path
                .canonicalize()
                .map_err(|e| format!("projeto indisponível: {e}"))?;
            if !canonical.is_dir() {
                return Err("caminho do projeto não é um diretório".into());
            }
            Ok(canonical.to_string_lossy().into_owned())
        }
    }
}

#[tauri::command]
async fn remember_project_memory(
    memory: State<'_, ProjectMemoryStore>,
    project_path: Option<String>,
    kind: String,
    title: String,
    content: String,
    tags: Vec<String>,
    importance: Option<u8>,
) -> Result<MemoryEntry, String> {
    let kind = match kind.as_str() {
        "fact" => MemoryKind::Fact,
        "decision" => MemoryKind::Decision,
        "constraint" => MemoryKind::Constraint,
        "pattern" => MemoryKind::Pattern,
        "outcome" => MemoryKind::Outcome,
        _ => return Err("tipo de memória inválido".into()),
    };
    let now = Utc::now();
    memory
        .remember(MemoryEntry {
            id: Uuid::new_v4(),
            kind,
            scope: project_memory_scope(project_path)?,
            title,
            content,
            tags,
            importance: importance.unwrap_or(5).clamp(1, 10),
            source: "user".into(),
            created_at: now,
            updated_at: now,
        })
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn search_project_memory(
    memory: State<'_, ProjectMemoryStore>,
    query: String,
    project_path: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<MemoryEntry>, String> {
    let scope = project_memory_scope(project_path)?;
    memory
        .search(&query, Some(&scope), limit.unwrap_or(30))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_project_memory(
    memory: State<'_, ProjectMemoryStore>,
    project_path: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<MemoryEntry>, String> {
    let scope = project_memory_scope(project_path)?;
    memory
        .list(Some(&scope), limit.unwrap_or(100))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_project_memory(
    memory: State<'_, ProjectMemoryStore>,
    id: String,
) -> Result<(), String> {
    let id = Uuid::parse_str(&id).map_err(|_| "memory id inválido".to_string())?;
    memory.delete(id).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_model_pricing(pricing: State<'_, PricingStore>) -> Result<Vec<ModelPricing>, String> {
    Ok(pricing.list().await.map_err(|e| e.to_string())?.models)
}

#[tauri::command]
async fn configure_model_pricing(
    pricing: State<'_, PricingStore>,
    provider: ProviderId,
    model: String,
    input_usd_per_million_tokens: f64,
    output_usd_per_million_tokens: f64,
) -> Result<Vec<ModelPricing>, String> {
    Ok(pricing
        .upsert(ModelPricing {
            provider,
            model,
            input_usd_per_million_tokens,
            output_usd_per_million_tokens,
            configured_by_user: false,
            updated_at: Utc::now(),
        })
        .await
        .map_err(|e| e.to_string())?
        .models)
}

#[tauri::command]
async fn estimate_model_cost(
    pricing: State<'_, PricingStore>,
    provider: ProviderId,
    model: String,
    input_tokens: u64,
    output_tokens: u64,
    budget: Option<ExecutionBudget>,
) -> Result<serde_json::Value, String> {
    let catalog = pricing.list().await.map_err(|e| e.to_string())?;
    let usage = TokenUsageInput {
        input_tokens,
        output_tokens,
    };
    let estimate = estimate_cost(&catalog, provider, &model, usage.clone());
    let budget_result = budget.map(|value| {
        assess_budget(
            &value,
            &usage,
            estimate.as_ref().map(|item| item.estimated_usd),
        )
    });
    Ok(serde_json::json!({ "estimate": estimate, "budget": budget_result }))
}

#[tauri::command]
async fn compile_and_save_delegation_workflow(
    store: State<'_, WorkflowStore>,
    memory: State<'_, ProjectMemoryStore>,
    prompt: String,
    request: agent_router::RouteRequest,
    project_path: Option<String>,
) -> Result<WorkflowDefinition, String> {
    if prompt.trim().is_empty() {
        return Err("prompt vazio".into());
    }
    let route = agent_router::recommend(&request);
    let mut blueprint = agent_router::delegation_blueprint(&prompt, &route);
    let scope = project_memory_scope(project_path)?;
    let memories = memory
        .search(&prompt, Some(&scope), 12)
        .await
        .map_err(|e| e.to_string())?;
    if !memories.is_empty() {
        for step in &mut blueprint.steps {
            step.objective = orchestrator_intelligence::augment_prompt_with_memory(
                &step.objective,
                &memories,
                12_000,
            );
        }
    }
    let workflow = compile_delegation_blueprint(&blueprint).map_err(|e| e.to_string())?;
    store.save(workflow).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn verify_audit_journal(audit: State<'_, AuditJournal>) -> Result<bool, String> {
    audit.verify().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn start_agent_task(
    manager: State<'_, ProcessManager>,
    request: AgentLaunchRequest,
) -> Result<String, String> {
    let spec = build_process_spec(request).map_err(|error| error.to_string())?;
    manager
        .start(spec)
        .await
        .map(|id| id.to_string())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn recommend_agent_route(
    request: agent_router::RouteRequest,
) -> Result<agent_router::RouteRecommendation, String> {
    if request.prompt.trim().is_empty() {
        return Err("prompt vazio".into());
    }
    Ok(agent_router::recommend(&request))
}

#[tauri::command]
fn build_delegation_blueprint(
    prompt: String,
    request: agent_router::RouteRequest,
) -> Result<agent_router::DelegationBlueprint, String> {
    if prompt.trim().is_empty() {
        return Err("prompt vazio".into());
    }
    let route = agent_router::recommend(&request);
    Ok(agent_router::delegation_blueprint(&prompt, &route))
}

#[tauri::command]
async fn cancel_task(manager: State<'_, ProcessManager>, task_id: String) -> Result<(), String> {
    let id: TaskId = task_id
        .parse()
        .map_err(|_| "task_id inválido".to_string())?;
    manager.cancel(id).await.map_err(|error| error.to_string())
}

#[tauri::command]
async fn list_tasks(manager: State<'_, ProcessManager>) -> Result<Vec<TaskSnapshot>, String> {
    Ok(manager.list_tasks().await)
}

#[tauri::command]
async fn create_worktree(
    manager: State<'_, WorkspaceManager>,
    request: CreateWorktreeRequest,
) -> Result<WorktreeInfo, String> {
    manager
        .create(request)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn list_worktrees(manager: State<'_, WorkspaceManager>) -> Result<Vec<WorktreeInfo>, String> {
    manager.list().await.map_err(|error| error.to_string())
}

#[tauri::command]
async fn remove_worktree(
    manager: State<'_, WorkspaceManager>,
    processes: State<'_, ProcessManager>,
    id: String,
    force: bool,
) -> Result<(), String> {
    let id = Uuid::parse_str(&id).map_err(|_| "worktree id inválido".to_string())?;
    let worktree = manager
        .list()
        .await
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| "worktree gerenciado não encontrado".to_string())?;
    let canonical_worktree =
        std::fs::canonicalize(&worktree.path).unwrap_or_else(|_| worktree.path.clone());
    let active_inside = processes.list_tasks().await.into_iter().any(|task| {
        if task.status.is_terminal() {
            return false;
        }
        let task_cwd = std::fs::canonicalize(&task.cwd).unwrap_or(task.cwd);
        task_cwd == canonical_worktree || task_cwd.starts_with(&canonical_worktree)
    });
    if active_inside {
        return Err(
            "Não é possível remover um worktree enquanto há um agente executando nele.".into(),
        );
    }
    manager
        .remove(id, force)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn validate_workflow(workflow: WorkflowDefinition) -> WorkflowValidation {
    validate_workflow_definition(&workflow)
}

#[tauri::command]
async fn save_workflow(
    store: State<'_, WorkflowStore>,
    workflow: WorkflowDefinition,
) -> Result<WorkflowDefinition, String> {
    store
        .save(workflow)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn list_workflows(
    store: State<'_, WorkflowStore>,
) -> Result<Vec<WorkflowDefinition>, String> {
    store.list().await.map_err(|error| error.to_string())
}

#[tauri::command]
async fn delete_workflow(store: State<'_, WorkflowStore>, id: String) -> Result<(), String> {
    let id = Uuid::parse_str(&id).map_err(|_| "workflow id inválido".to_string())?;
    store.delete(id).await.map_err(|error| error.to_string())
}

#[tauri::command]
async fn run_workflow(
    runner: State<'_, WorkflowRunner>,
    store: State<'_, WorkflowStore>,
    workflow_id: String,
    repository: std::path::PathBuf,
    initial_prompt: String,
    policy: Option<WorkflowRunPolicy>,
    history: State<'_, WorkflowRunStore>,
) -> Result<WorkflowRunResult, String> {
    let id = Uuid::parse_str(&workflow_id).map_err(|_| "workflow_id inválido".to_string())?;
    let workflow = store
        .list()
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|w| w.id == id)
        .ok_or_else(|| "workflow não encontrado".to_string())?;
    let result = runner
        .run(WorkflowRunRequest {
            workflow,
            repository,
            initial_prompt,
            policy: policy.unwrap_or_default(),
            run_id: None,
            checkpoint_path: None,
            resume: None,
        })
        .await
        .map_err(|e| e.to_string())?;
    history
        .record(result.clone())
        .await
        .map_err(|e| format!("execução concluída, mas o histórico não pôde ser salvo: {e}"))?;
    Ok(result)
}

#[derive(Debug, Clone, serde::Serialize)]
struct WorkflowExecutionSnapshot {
    run_id: Uuid,
    workflow_id: Uuid,
    status: String,
    started_at: chrono::DateTime<Utc>,
    updated_at: chrono::DateTime<Utc>,
    events: Vec<WorkflowProgressEvent>,
    result: Option<WorkflowRunResult>,
    error: Option<String>,
}

#[derive(Clone, Default)]
struct WorkflowExecutionManager {
    snapshots: std::sync::Arc<
        tokio::sync::Mutex<std::collections::HashMap<Uuid, WorkflowExecutionSnapshot>>,
    >,
    cancellations: std::sync::Arc<
        tokio::sync::Mutex<std::collections::HashMap<Uuid, tokio::sync::watch::Sender<bool>>>,
    >,
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn start_workflow(
    app: AppHandle,
    executions: State<'_, WorkflowExecutionManager>,
    runner: State<'_, WorkflowRunner>,
    store: State<'_, WorkflowStore>,
    history: State<'_, WorkflowRunStore>,
    workflow_id: String,
    repository: std::path::PathBuf,
    initial_prompt: String,
    policy: Option<WorkflowRunPolicy>,
    audit: State<'_, AuditJournal>,
) -> Result<WorkflowExecutionSnapshot, String> {
    let workflow_uuid =
        Uuid::parse_str(&workflow_id).map_err(|_| "workflow_id inválido".to_string())?;
    let workflow = store
        .list()
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|w| w.id == workflow_uuid)
        .ok_or_else(|| "workflow não encontrado".to_string())?;
    let run_id = Uuid::new_v4();
    let now = Utc::now();
    let snapshot = WorkflowExecutionSnapshot {
        run_id,
        workflow_id: workflow_uuid,
        status: "queued".into(),
        started_at: now,
        updated_at: now,
        events: Vec::new(),
        result: None,
        error: None,
    };
    audit
        .append(AuditEvent {
            actor: "desktop".into(),
            action: "workflow.start".into(),
            subject: run_id.to_string(),
            decision: "accepted".into(),
            detail: format!("workflow_id={workflow_uuid}"),
        })
        .await
        .map_err(|e| format!("não foi possível registrar auditoria antes da execução: {e}"))?;
    executions
        .snapshots
        .lock()
        .await
        .insert(run_id, snapshot.clone());
    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    executions
        .cancellations
        .lock()
        .await
        .insert(run_id, cancel_tx);
    let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();
    let manager = executions.inner().clone();
    let runner = runner.inner().clone();
    let history = history.inner().clone();
    let checkpoint_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("workflow-checkpoints");
    let request = WorkflowRunRequest {
        workflow,
        repository,
        initial_prompt,
        policy: policy.unwrap_or_default(),
        run_id: Some(run_id),
        checkpoint_path: Some(checkpoint_dir),
        resume: None,
    };
    tokio::spawn(async move {
        let mut execution =
            tokio::spawn(async move { runner.run_controlled(request, cancel_rx, event_tx).await });
        let mut events_open = true;
        loop {
            tokio::select! {
                event = event_rx.recv(), if events_open => {
                    if let Some(event) = event {
                        if let Some(snapshot) = manager.snapshots.lock().await.get_mut(&run_id) {
                            if matches!(event.event.as_str(), "started" | "cancelled" | "finished") {
                                snapshot.status = event.status.clone();
                            } else if snapshot.status == "queued" {
                                snapshot.status = "running".into();
                            }
                            snapshot.updated_at = Utc::now();
                            snapshot.events.push(event.clone());
                            if snapshot.events.len() > 500 { snapshot.events.remove(0); }
                        }
                        let _ = app.emit("workflow-progress", event);
                    } else { events_open = false; }
                }
                result = &mut execution => {
                    let (status, value, error) = match result {
                        Ok(Ok(value)) => (value.status.clone(), Some(value), None),
                        Ok(Err(error)) => {
                            let message = error.to_string();
                            let status = if message.contains("cancelado") { "cancelled" } else { "failed" };
                            (status.to_string(), None, Some(message))
                        }
                        Err(error) => ("failed".to_string(), None, Some(format!("falha interna: {error}"))),
                    };
                    if let Some(value) = value.as_ref() { let _ = history.record(value.clone()).await; }
                    if let Some(snapshot) = manager.snapshots.lock().await.get_mut(&run_id) {
                        snapshot.status = status.clone();
                        snapshot.updated_at = Utc::now();
                        snapshot.result = value;
                        snapshot.error = error.clone();
                    }
                    let _ = app.emit("workflow-execution-finished", serde_json::json!({"run_id": run_id, "status": status, "error": error}));
                    manager.cancellations.lock().await.remove(&run_id);
                    break;
                }
            }
        }
    });
    Ok(snapshot)
}

#[tauri::command]
async fn list_workflow_executions(
    executions: State<'_, WorkflowExecutionManager>,
) -> Result<Vec<WorkflowExecutionSnapshot>, String> {
    let mut values: Vec<_> = executions
        .snapshots
        .lock()
        .await
        .values()
        .cloned()
        .collect();
    values.sort_by_key(|a| std::cmp::Reverse(a.started_at));
    values.truncate(100);
    Ok(values)
}

#[tauri::command]
async fn cancel_workflow(
    executions: State<'_, WorkflowExecutionManager>,
    audit: State<'_, AuditJournal>,
    run_id: String,
) -> Result<(), String> {
    let id = Uuid::parse_str(&run_id).map_err(|_| "run_id inválido".to_string())?;
    let sender = executions
        .cancellations
        .lock()
        .await
        .get(&id)
        .cloned()
        .ok_or_else(|| "workflow não está em execução".to_string())?;
    audit
        .append(AuditEvent {
            actor: "desktop".into(),
            action: "workflow.cancel".into(),
            subject: id.to_string(),
            decision: "requested".into(),
            detail: "cancelamento cooperativo solicitado".into(),
        })
        .await
        .map_err(|e| e.to_string())?;
    sender
        .send(true)
        .map_err(|_| "workflow já encerrou".to_string())?;
    Ok(())
}

#[tauri::command]
async fn list_workflow_runs(
    history: State<'_, WorkflowRunStore>,
    limit: Option<usize>,
) -> Result<Vec<WorkflowRunResult>, String> {
    history
        .list(limit.unwrap_or(30))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_workflow_checkpoints(
    app: AppHandle,
    executions: State<'_, WorkflowExecutionManager>,
) -> Result<Vec<WorkflowCheckpoint>, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("workflow-checkpoints");
    let active: std::collections::HashSet<Uuid> = executions
        .snapshots
        .lock()
        .await
        .values()
        .filter(|item| matches!(item.status.as_str(), "queued" | "running"))
        .map(|item| item.run_id)
        .collect();
    let store = WorkflowCheckpointStore::new(directory);
    let mut checkpoints = store.list().await.map_err(|e| e.to_string())?;
    for item in &mut checkpoints {
        if matches!(item.status.as_str(), "queued" | "running") && !active.contains(&item.run_id) {
            item.status = "interrupted".into();
            item.recovery_note = Some("A execução não está mais ativa no Host. Inspecione o worktree e os efeitos produzidos antes de retomar.".into());
            store.save(item).await.map_err(|e| e.to_string())?;
        }
    }
    Ok(checkpoints)
}

#[tauri::command]
async fn assess_checkpoint_resume(
    app: AppHandle,
    workspaces: State<'_, WorkspaceManager>,
    checkpoint_id: String,
) -> Result<WorkflowResumeAssessment, String> {
    let id = Uuid::parse_str(&checkpoint_id).map_err(|_| "checkpoint_id inválido".to_string())?;
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("workflow-checkpoints");
    let checkpoint = WorkflowCheckpointStore::new(directory)
        .list()
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|item| item.run_id == id)
        .ok_or_else(|| "checkpoint não encontrado".to_string())?;
    let mut assessment = assess_workflow_resume(&checkpoint).await;
    if let Some(path) = checkpoint.execution_workspace.as_ref() {
        let managed = workspaces.list().await.map_err(|e| e.to_string())?;
        let canonical = path.canonicalize().ok();
        let owned = canonical.is_some()
            && managed
                .iter()
                .any(|item| item.present && item.path.canonicalize().ok() == canonical);
        if !owned {
            assessment.can_resume = false;
            assessment.execution_workspace_matches = false;
            assessment.warnings.push("Worktree do checkpoint não está registrado como worktree gerenciado pelo Orchestrator.".into());
        }
    }
    Ok(assessment)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
async fn resume_workflow(
    app: AppHandle,
    executions: State<'_, WorkflowExecutionManager>,
    runner: State<'_, WorkflowRunner>,
    history: State<'_, WorkflowRunStore>,
    workspaces: State<'_, WorkspaceManager>,
    checkpoint_id: String,
    retry_failed_nodes: bool,
    confirm_rerun_unfinished: bool,
    audit: State<'_, AuditJournal>,
) -> Result<WorkflowExecutionSnapshot, String> {
    if !confirm_rerun_unfinished {
        return Err(
            "retomada cancelada: confirme a possível repetição de operações ainda sem resultado"
                .into(),
        );
    }
    let id = Uuid::parse_str(&checkpoint_id).map_err(|_| "checkpoint_id inválido".to_string())?;
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("workflow-checkpoints");
    let checkpoint_store = WorkflowCheckpointStore::new(directory.clone());
    let mut checkpoint = checkpoint_store
        .list()
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|item| item.run_id == id)
        .ok_or_else(|| "checkpoint não encontrado".to_string())?;
    let still_active = executions
        .snapshots
        .lock()
        .await
        .get(&id)
        .map(|item| matches!(item.status.as_str(), "queued" | "running"))
        .unwrap_or(false);
    if matches!(checkpoint.status.as_str(), "queued" | "running") && !still_active {
        checkpoint.status = "interrupted".into();
        checkpoint.recovery_note =
            Some("Execução sem processo ativo no Host; estado marcado como interrompido.".into());
        checkpoint_store
            .save(&checkpoint)
            .await
            .map_err(|e| e.to_string())?;
    }
    let mut assessment = assess_workflow_resume(&checkpoint).await;
    if let Some(path) = checkpoint.execution_workspace.as_ref() {
        let managed = workspaces.list().await.map_err(|e| e.to_string())?;
        let canonical = path.canonicalize().ok();
        let owned = canonical.is_some()
            && managed
                .iter()
                .any(|item| item.present && item.path.canonicalize().ok() == canonical);
        if !owned {
            assessment.can_resume = false;
            assessment.execution_workspace_matches = false;
            assessment.warnings.push("Worktree do checkpoint não está registrado como worktree gerenciado pelo Orchestrator.".into());
        }
    }
    if !assessment.can_resume {
        return Err(format!(
            "retomada bloqueada: {}",
            assessment.warnings.join(" ")
        ));
    }

    let run_id = Uuid::new_v4();
    let now = Utc::now();
    let snapshot = WorkflowExecutionSnapshot {
        run_id,
        workflow_id: checkpoint.workflow.id,
        status: "queued".into(),
        started_at: now,
        updated_at: now,
        events: Vec::new(),
        result: None,
        error: None,
    };
    audit
        .append(AuditEvent {
            actor: "desktop".into(),
            action: "workflow.resume".into(),
            subject: run_id.to_string(),
            decision: "accepted".into(),
            detail: format!("resumed_from={id}; retry_failed_nodes={retry_failed_nodes}"),
        })
        .await
        .map_err(|e| format!("não foi possível registrar auditoria antes da retomada: {e}"))?;
    executions
        .snapshots
        .lock()
        .await
        .insert(run_id, snapshot.clone());
    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    executions
        .cancellations
        .lock()
        .await
        .insert(run_id, cancel_tx);
    let (event_tx, mut event_rx) = tokio::sync::mpsc::unbounded_channel();
    let manager = executions.inner().clone();
    let runner = runner.inner().clone();
    let history = history.inner().clone();
    let request = WorkflowRunRequest {
        workflow: checkpoint.workflow.clone(),
        repository: checkpoint.repository.clone(),
        initial_prompt: checkpoint.initial_prompt.clone(),
        policy: checkpoint.policy.clone(),
        run_id: Some(run_id),
        checkpoint_path: Some(directory),
        resume: Some(WorkflowResumeInput {
            checkpoint,
            retry_failed_nodes,
            confirm_rerun_unfinished,
        }),
    };
    tokio::spawn(async move {
        let mut execution =
            tokio::spawn(async move { runner.run_controlled(request, cancel_rx, event_tx).await });
        let mut events_open = true;
        loop {
            tokio::select! {
                event = event_rx.recv(), if events_open => {
                    if let Some(event) = event {
                        if let Some(snapshot) = manager.snapshots.lock().await.get_mut(&run_id) {
                            if matches!(event.event.as_str(), "started" | "cancelled" | "finished") { snapshot.status = event.status.clone(); }
                            else if snapshot.status == "queued" { snapshot.status = "running".into(); }
                            snapshot.updated_at = Utc::now(); snapshot.events.push(event.clone());
                            if snapshot.events.len() > 500 { snapshot.events.remove(0); }
                        }
                        let _ = app.emit("workflow-progress", event);
                    } else { events_open = false; }
                }
                result = &mut execution => {
                    let (status, value, error) = match result {
                        Ok(Ok(value)) => (value.status.clone(), Some(value), None),
                        Ok(Err(error)) => { let message = error.to_string(); let status = if message.contains("cancelado") { "cancelled" } else { "failed" }; (status.to_string(), None, Some(message)) },
                        Err(error) => ("failed".to_string(), None, Some(format!("falha interna: {error}"))),
                    };
                    if let Some(value) = value.as_ref() { let _ = history.record(value.clone()).await; }
                    if let Some(snapshot) = manager.snapshots.lock().await.get_mut(&run_id) { snapshot.status = status.clone(); snapshot.updated_at = Utc::now(); snapshot.result = value; snapshot.error = error.clone(); }
                    let _ = app.emit("workflow-execution-finished", serde_json::json!({"run_id": run_id, "status": status, "error": error}));
                    manager.cancellations.lock().await.remove(&run_id);
                    break;
                }
            }
        }
    });
    Ok(snapshot)
}

#[tauri::command]
async fn start_remote_server(
    controller: State<'_, RemoteServerController>,
    enable_lan: bool,
) -> Result<RemoteServerInfo, String> {
    controller
        .start(enable_lan)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn stop_remote_server(controller: State<'_, RemoteServerController>) -> Result<(), String> {
    controller.stop().await.map_err(|error| error.to_string())
}

#[tauri::command]
async fn remote_server_info(
    controller: State<'_, RemoteServerController>,
) -> Result<RemoteServerInfo, String> {
    Ok(controller.info().await)
}

#[tauri::command]
async fn create_remote_pairing(
    controller: State<'_, RemoteServerController>,
) -> Result<PairingInfo, String> {
    controller
        .create_pairing()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn list_paired_devices(
    controller: State<'_, RemoteServerController>,
) -> Result<Vec<PairedDevice>, String> {
    controller
        .list_devices()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn revoke_paired_device(
    controller: State<'_, RemoteServerController>,
    id: String,
) -> Result<(), String> {
    controller
        .revoke_device(id)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn list_approvals(
    bridge: State<'_, CodexApprovalBridge>,
    claude: State<'_, ClaudeApprovalBridge>,
) -> Result<Vec<PermissionRequest>, String> {
    let mut items = bridge.list().await;
    items.extend(claude.list().await);
    items.sort_by_key(|a| std::cmp::Reverse(a.created_at));
    Ok(items)
}

#[tauri::command]
async fn decide_approval(
    bridge: State<'_, CodexApprovalBridge>,
    claude: State<'_, ClaudeApprovalBridge>,
    permissions: State<'_, PermissionEngine>,
    id: String,
    approve: bool,
) -> Result<PermissionRequest, String> {
    let id = Uuid::parse_str(&id).map_err(|_| "approval id inválido".to_string())?;
    let provider = permissions
        .list()
        .await
        .into_iter()
        .find(|item| item.id == id)
        .map(|item| item.provider);
    match provider.as_deref() {
        Some("claude_code") => claude
            .decide(id, approve, "desktop:local-user".into())
            .await
            .map_err(|error| error.to_string()),
        _ => bridge
            .decide(id, approve, "desktop:local-user".into())
            .await
            .map_err(|error| error.to_string()),
    }
}

#[tauri::command]
async fn get_usage_snapshot(
    manager: State<'_, ProcessManager>,
    usage: State<'_, UsageMonitor>,
) -> Result<UsageSnapshot, String> {
    let tasks = manager.list_tasks().await;
    Ok(usage.snapshot(&tasks).await)
}

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    tauri::Builder::default()
        .setup(|app| {
            let manager = ProcessManager::new(ProcessManagerConfig {
                max_parallel_processes: 4,
                ..Default::default()
            });
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;
            let workspace_manager = WorkspaceManager::new(app_data_dir.join("worktrees"));
            let workflow_store = WorkflowStore::new(app_data_dir.join("workflows"));
            let workflow_runner = WorkflowRunner::new(manager.clone(), workspace_manager.clone());
            let workflow_run_store = WorkflowRunStore::new(app_data_dir.join("workflow-runs.json"));
            let project_memory_store = ProjectMemoryStore::new(app_data_dir.join("project-memory.json"));
            let pricing_store = PricingStore::new(app_data_dir.join("model-pricing.json"));
            let audit_journal = AuditJournal::new(app_data_dir.join("audit.jsonl"));
            let session_registry = tauri::async_runtime::block_on(SessionRegistry::open(app_data_dir.join("sessions.json")))?;
            let usage_monitor = UsageMonitor::default();
            let permission_engine = PermissionEngine::default();
            let codex_app_server = CodexAppServerManager::default();
            let codex_approval_bridge = CodexApprovalBridge::new(codex_app_server.clone(), permission_engine.clone());
            let claude_code_manager = ClaudeCodeManager::default();
            let claude_approval_bridge = ClaudeApprovalBridge::new(claude_code_manager.clone(), permission_engine.clone());
            let claude_approval_task = claude_approval_bridge.clone();
            tauri::async_runtime::spawn(async move { claude_approval_task.run().await; });
            let approval_bridge_task = codex_approval_bridge.clone();
            tauri::async_runtime::spawn(async move { approval_bridge_task.run().await; });
            let remote_controller = RemoteServerController::new(
                manager.clone(),
                usage_monitor.clone(),
                workflow_store.clone(),
                workflow_runner.clone(),
                workflow_run_store.clone(),
                codex_approval_bridge.clone(),
                claude_approval_bridge.clone(),
                claude_code_manager.clone(),
                codex_app_server.clone(),
                session_registry.clone(),
                app_data_dir.join("remote-devices.sqlite3"),
                std::env::var_os("USERPROFILE")
                    .or_else(|| std::env::var_os("HOME"))
                    .map(std::path::PathBuf::from)
                    .unwrap_or_else(|| app_data_dir.clone()),
            );

            app.manage(manager.clone());
            app.manage(workspace_manager);
            app.manage(workflow_store);
            app.manage(workflow_runner);
            app.manage(workflow_run_store);
            app.manage(project_memory_store);
            app.manage(pricing_store);
            app.manage(audit_journal);
            app.manage(WorkflowExecutionManager::default());
            app.manage(session_registry.clone());
            app.manage(permission_engine);
            app.manage(codex_app_server.clone());
            app.manage(claude_code_manager.clone());
            app.manage(claude_approval_bridge);
            app.manage(codex_approval_bridge);
            app.manage(usage_monitor.clone());
            app.manage(remote_controller);

            let claude_handle = app.handle().clone();
            let mut claude_events = claude_code_manager.subscribe();
            let claude_registry = session_registry.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match claude_events.recv().await {
                        Ok(event) => {
                            let status = match event.event_type.as_str() { "transport/closed" => Some("disconnected"), "result" => Some("idle"), _ => None };
                            if let Some(status) = status {
                                let preserve_stopped = status == "disconnected" && claude_registry.get(event.session_id).await.map(|item| item.status == "stopped").unwrap_or(false);
                                if !preserve_stopped { let _ = claude_registry.set_status(event.session_id, status, None).await; }
                            }
                            let _ = claude_handle.emit("claude-event", event);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => tracing::warn!(skipped, "Claude event stream lagged; refresh session state"),
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            });

            // Feed provider-specific live token and quota observations from the
            // same task-event stream already consumed by the Desktop UI.
            let usage_manager = manager.clone();
            let mut usage_events = manager.subscribe();
            tauri::async_runtime::spawn(async move {
                loop {
                    match usage_events.recv().await {
                        Ok(event) => {
                            let provider = usage_manager.get_task(event.task_id).await.and_then(|task| task.provider);
                            usage_monitor.observe_event(&event, provider).await;
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                            tracing::warn!(skipped, "usage monitor missed task events; historical scan will reconcile persisted usage");
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            });

            let app_handle = app.handle().clone();
            let mut events = manager.subscribe();
            let task_manager = manager.clone();
            let antigravity_registry = session_registry.clone();
            tauri::async_runtime::spawn(async move {
                let manager = task_manager;
                loop {
                    match events.recv().await {
                        Ok(event) => {
                            if matches!(&event.payload, TaskEventPayload::Exited { .. }) {
                                if let Some(task) = manager.get_task(event.task_id).await {
                                    if task.provider == Some(ProviderId::Antigravity) {
                                        if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(std::path::PathBuf::from) {
                                            if let Ok(Some(native_id)) = read_workspace_conversation(default_cache_path(home), &task.cwd) {
                                                let existing = antigravity_registry.list().await.into_iter().any(|item| item.provider == SessionProvider::Antigravity && item.cwd == task.cwd && item.external_session_id.as_deref() == Some(native_id.as_str()));
                                                if !existing {
                                                    let now = Utc::now();
                                                    let _ = antigravity_registry.upsert(ManagedSession { id: Uuid::new_v4(), provider: SessionProvider::Antigravity, external_session_id: Some(native_id), cwd: task.cwd.clone(), model: task.model.clone(), status: if task.exit_code == Some(0) { "idle" } else { "failed" }.into(), recovery_mode: RecoveryMode::NativeResume, recovery_note: "Conversa descoberta automaticamente no cache oficial do Antigravity para este workspace.".into(), started_at: task.started_at.unwrap_or(task.created_at), updated_at: now, last_error: task.last_error.clone() }).await;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            let _ = app_handle.emit("task-event", event);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                            tracing::warn!(skipped, "frontend event listener lagged; refresh task snapshots");
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            });

            let codex_handle = app.handle().clone();
            let mut codex_events = codex_app_server.subscribe();
            let codex_registry = session_registry.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match codex_events.recv().await {
                        Ok(event) => {
                            let status = match event.method.as_str() { "turn/started" => Some("running"), "turn/completed" => Some("idle"), "transport/closed" => Some("disconnected"), _ => None };
                            if let Some(status) = status {
                                let preserve_stopped = status == "disconnected" && codex_registry.get(event.session_id).await.map(|item| item.status == "stopped").unwrap_or(false);
                                if !preserve_stopped { let _ = codex_registry.set_status(event.session_id, status, None).await; }
                            }
                            let _ = codex_handle.emit("codex-event", event);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                            tracing::warn!(skipped, "Codex event stream lagged; refresh Codex session state");
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_agent_task, cancel_task, list_tasks,
            skills::list_skills, skills::import_skills,
            remember_project_memory, search_project_memory, list_project_memory, delete_project_memory,
            list_model_pricing, configure_model_pricing, estimate_model_cost, compile_and_save_delegation_workflow, verify_audit_journal,
            create_worktree, list_worktrees, remove_worktree,
            validate_workflow, save_workflow, list_workflows, delete_workflow, run_workflow, start_workflow, list_workflow_executions, cancel_workflow, list_workflow_runs, list_workflow_checkpoints, assess_checkpoint_resume, resume_workflow,
            start_remote_server, stop_remote_server, remote_server_info,
            create_remote_pairing, list_paired_devices, revoke_paired_device,
            get_usage_snapshot, list_approvals, decide_approval,
            start_claude_session, resume_claude_session, list_claude_sessions, send_claude_message, stop_claude_session,
            start_codex_session, resume_codex_session, list_codex_sessions, respond_codex_approval, stop_codex_session,
            import_antigravity_workspace_session, resume_antigravity_session,
            list_managed_sessions, list_provider_capabilities, recommend_agent_route, build_delegation_blueprint
        ])
        .run(tauri::generate_context!())
        .expect("falha ao executar o Psylium Desktop");
}
