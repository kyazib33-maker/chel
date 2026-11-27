import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentLaunchRequest, CreateWorktreeRequest, ProviderId, TaskEvent, TaskSnapshot,
  WorkflowDefinition, WorkflowValidation, WorktreeInfo,
  PairingInfo, PairedDevice, RemoteServerInfo, UsageSnapshot,
} from "@orchestrator/shared-types";

export type {
  AgentLaunchRequest, AgentNodeDefinition, ContextMode, ProviderId, TaskEvent, TaskSnapshot, TaskStatus,
  WorkflowDefinition, WorkflowValidation, WorktreeInfo, WorktreeMode,
  PairingInfo, PairedDevice, RemoteServerInfo, UsageSnapshot, ProviderUsage, TokenTotals, QuotaStatus,
} from "@orchestrator/shared-types";

export const desktopBridgeAvailable = isTauri();
export const launchAgent = (request: AgentLaunchRequest) => invoke<string>("start_agent_task", { request });
export const cancelTask = (taskId: string) => invoke<void>("cancel_task", { taskId });
export const listTasks = () => invoke<TaskSnapshot[]>("list_tasks");
export const onTaskEvent = (handler: (event: TaskEvent) => void): Promise<UnlistenFn> =>
  listen<TaskEvent>("task-event", (event) => handler(event.payload));

export const createWorktree = (request: CreateWorktreeRequest) =>
  invoke<WorktreeInfo>("create_worktree", { request });
export const listWorktrees = () => invoke<WorktreeInfo[]>("list_worktrees");
export const removeWorktree = (id: string, force = false) =>
  invoke<void>("remove_worktree", { id, force });

export const validateWorkflow = (workflow: WorkflowDefinition) =>
  invoke<WorkflowValidation>("validate_workflow", { workflow });
export const saveWorkflow = (workflow: WorkflowDefinition) =>
  invoke<WorkflowDefinition>("save_workflow", { workflow });
export const listWorkflows = () => invoke<WorkflowDefinition[]>("list_workflows");
export const deleteWorkflow = (id: string) => invoke<void>("delete_workflow", { id });
export type WorkflowRunResult = { run_id: string; workflow_id: string; status: string; started_at: string; finished_at: string; nodes: Array<{ node_id: string; task_id: string | null; status: string; output: string; error: string | null; started_at: string; finished_at: string }> };
export type WorkflowRunPolicy = {
  max_nodes: number;
  max_node_runtime_seconds: number;
  max_total_runtime_seconds: number;
  max_output_bytes: number;
  require_review_node: boolean;
};
export const runWorkflow = (workflowId: string, repository: string, initialPrompt: string, policy?: WorkflowRunPolicy) =>
  invoke<WorkflowRunResult>("run_workflow", { workflowId, repository, initialPrompt, policy: policy ?? null });
export const listWorkflowRuns = (limit = 30) => invoke<WorkflowRunResult[]>("list_workflow_runs", { limit });
export type WorkflowCheckpoint = { run_id: string; resumed_from?: string | null; process_id: number; workflow: WorkflowDefinition; repository: string; initial_prompt: string; completed_nodes: WorkflowRunResult["nodes"]; repository_fingerprint?: string | null; execution_workspace?: string | null; execution_workspace_fingerprint?: string | null; status: string; started_at: string; updated_at: string; recovery_note: string | null };
export type WorkflowResumeAssessment = { run_id: string; can_resume: boolean; stored_fingerprint: string | null; current_fingerprint: string | null; execution_workspace_matches: boolean; successful_nodes: string[]; retryable_nodes: string[]; warnings: string[] };
export const listWorkflowCheckpoints = () => invoke<WorkflowCheckpoint[]>("list_workflow_checkpoints");
export const assessCheckpointResume = (checkpointId: string) => invoke<WorkflowResumeAssessment>("assess_checkpoint_resume", { checkpointId });
export const resumeWorkflow = (checkpointId: string, retryFailedNodes: boolean, confirmRerunUnfinished: boolean) =>
  invoke<WorkflowExecutionSnapshot>("resume_workflow", { checkpointId, retryFailedNodes, confirmRerunUnfinished });
export type WorkflowProgressEvent = { run_id: string; workflow_id: string; node_id: string | null; event: string; status: string; at: string };
export type WorkflowExecutionSnapshot = { run_id: string; workflow_id: string; status: string; started_at: string; updated_at: string; events: WorkflowProgressEvent[]; result: WorkflowRunResult | null; error: string | null };
export const startWorkflow = (workflowId: string, repository: string, initialPrompt: string, policy?: WorkflowRunPolicy) =>
  invoke<WorkflowExecutionSnapshot>("start_workflow", { workflowId, repository, initialPrompt, policy: policy ?? null });
export const listWorkflowExecutions = () => invoke<WorkflowExecutionSnapshot[]>("list_workflow_executions");
export const cancelWorkflow = (runId: string) => invoke<void>("cancel_workflow", { runId });
export const onWorkflowProgress = (handler: (event: WorkflowProgressEvent) => void): Promise<UnlistenFn> =>
  listen<WorkflowProgressEvent>("workflow-progress", (event) => handler(event.payload));
export const onWorkflowFinished = (handler: (event: { run_id: string; status: string; error: string | null }) => void): Promise<UnlistenFn> =>
  listen<{ run_id: string; status: string; error: string | null }>("workflow-execution-finished", (event) => handler(event.payload));


export const startRemoteServer = (enableLan: boolean) =>
  invoke<RemoteServerInfo>("start_remote_server", { enableLan });
export const stopRemoteServer = () => invoke<void>("stop_remote_server");
export const getRemoteServerInfo = () => invoke<RemoteServerInfo>("remote_server_info");
export const createRemotePairing = () => invoke<PairingInfo>("create_remote_pairing");
export const listPairedDevices = () => invoke<PairedDevice[]>("list_paired_devices");
export const revokePairedDevice = (id: string) => invoke<void>("revoke_paired_device", { id });
export const getUsageSnapshot = () => invoke<UsageSnapshot>("get_usage_snapshot");

export type PermissionRequest = {
  id: string; task_id: string; provider: string; tool_name: string;
  action: "read" | "write" | "execute" | "network" | "destructive";
  summary: string; input_preview: string; status: "pending" | "approved" | "denied" | "expired";
  created_at: string; expires_at: string; decided_at: string | null; decided_by: string | null;
};
export const listApprovals = () => invoke<PermissionRequest[]>("list_approvals");
export const decideApproval = (id: string, approve: boolean) =>
  invoke<PermissionRequest>("decide_approval", { id, approve });


export type CodexSessionInfo = { id: string; thread_id: string; cwd: string; status: string; started_at: string };
export type CodexEvent = { session_id: string; method: string; params: Record<string, unknown>; request_id?: unknown };
export type CodexStartRequest = { cwd: string; prompt: string; model: string | null; sandbox: string; persistent: boolean; resume_thread_id?: string | null };
export const startCodexSession = (request: CodexStartRequest) => invoke<CodexSessionInfo>("start_codex_session", { request });
export const listCodexSessions = () => invoke<CodexSessionInfo[]>("list_codex_sessions");
export const resumeCodexSession = (sessionId: string, prompt: string) => invoke<CodexSessionInfo>("resume_codex_session", { sessionId, prompt });
export const approveCodexRequest = (sessionId: string, requestId: unknown, decision: string) =>
  invoke<void>("respond_codex_approval", { sessionId, requestId, decision });
export const stopCodexSession = (sessionId: string) => invoke<void>("stop_codex_session", { sessionId });
export const onCodexEvent = (handler: (event: CodexEvent) => void): Promise<UnlistenFn> =>
  listen<CodexEvent>("codex-event", (event) => handler(event.payload));

export type ClaudeSessionInfo = { id: string; claude_session_id: string | null; cwd: string; model: string | null; status: string; started_at: string };
export type ClaudeEvent = { session_id: string; event_type: string; payload: Record<string, unknown> };
export type ClaudeStartRequest = { cwd: string; prompt: string; model: string | null; effort: string | null; permission_mode: string; resume_session_id?: string | null };
export const startClaudeSession = (request: ClaudeStartRequest) => invoke<ClaudeSessionInfo>("start_claude_session", { request });
export const listClaudeSessions = () => invoke<ClaudeSessionInfo[]>("list_claude_sessions");
export const resumeClaudeSession = (sessionId: string, prompt: string) => invoke<ClaudeSessionInfo>("resume_claude_session", { sessionId, prompt });
export const sendClaudeMessage = (sessionId: string, prompt: string) => invoke<void>("send_claude_message", { sessionId, prompt });
export const stopClaudeSession = (sessionId: string) => invoke<void>("stop_claude_session", { sessionId });
export const onClaudeEvent = (handler: (event: ClaudeEvent) => void): Promise<UnlistenFn> =>
  listen<ClaudeEvent>("claude-event", (event) => handler(event.payload));


export type ManagedSession = {
  id: string; provider: "claude_code" | "codex" | "antigravity";
  external_session_id: string | null; cwd: string; model: string | null; status: string;
  recovery_mode: "native_resume" | "metadata_only" | "unsupported"; recovery_note: string;
  started_at: string; updated_at: string; last_error: string | null;
};
export const listManagedSessions = () => invoke<ManagedSession[]>("list_managed_sessions");
export const importAntigravityWorkspaceSession = (cwd: string) => invoke<ManagedSession>("import_antigravity_workspace_session", { cwd });
export const resumeAntigravitySession = (sessionId: string, prompt: string) => invoke<string>("resume_antigravity_session", { sessionId, prompt });

export type RouteRecommendation = {
  task_kind: "coding" | "debugging" | "testing" | "research" | "writing" | "planning" | "general";
  complexity: "low" | "medium" | "high";
  provider: ProviderId;
  model: string | null;
  effort: string;
  confidence: number;
  rationale: string[];
  fallback_order: ProviderId[];
  candidates: Array<{ provider: ProviderId; score: number; reasons: string[] }>;
  execution_requires_confirmation: boolean;
};
export type DelegationBlueprint = {
  title: string;
  steps: Array<{ id: string; role: string; objective: string; suggested_provider: ProviderId; effort: string; depends_on: string[]; isolated_workspace: boolean }>;
  note: string;
};
export type RouteRequest = { prompt: string; preferred_provider?: ProviderId | null; quality?: "economy" | "balanced" | "maximum" | null; allow_antigravity?: boolean };
export const recommendAgentRoute = (request: RouteRequest) => invoke<RouteRecommendation>("recommend_agent_route", { request });
export const buildDelegationBlueprint = (prompt: string, request: RouteRequest) => invoke<DelegationBlueprint>("build_delegation_blueprint", { prompt, request });

export type MemoryKind = "fact" | "decision" | "constraint" | "pattern" | "outcome";
export type MemoryEntry = { id: string; kind: MemoryKind; scope: string; title: string; content: string; tags: string[]; importance: number; source: string; created_at: string; updated_at: string };
export type ModelPricing = { provider: ProviderId; model: string; input_usd_per_million_tokens: number; output_usd_per_million_tokens: number; configured_by_user: boolean; updated_at: string };
export type ExecutionBudget = { max_input_tokens?: number | null; max_output_tokens?: number | null; max_estimated_usd?: number | null };
export type CostEstimateResponse = { estimate: { provider: ProviderId; model: string; input_tokens: number; output_tokens: number; estimated_usd: number; pricing_updated_at: string; disclaimer: string } | null; budget: { allowed: boolean; reasons: string[] } | null };
export const rememberProjectMemory = (data: { projectPath?: string | null; kind: MemoryKind; title: string; content: string; tags: string[]; importance?: number }) =>
  invoke<MemoryEntry>("remember_project_memory", { projectPath: data.projectPath ?? null, kind: data.kind, title: data.title, content: data.content, tags: data.tags, importance: data.importance ?? 5 });
export const searchProjectMemory = (query: string, projectPath?: string | null) =>
  invoke<MemoryEntry[]>("search_project_memory", { query, projectPath: projectPath ?? null, limit: 50 });
export const deleteProjectMemory = (id: string) => invoke<void>("delete_project_memory", { id });
export const listModelPricing = () => invoke<ModelPricing[]>("list_model_pricing");
export const configureModelPricing = (provider: ProviderId, model: string, inputUsdPerMillionTokens: number, outputUsdPerMillionTokens: number) =>
  invoke<ModelPricing[]>("configure_model_pricing", { provider, model, inputUsdPerMillionTokens, outputUsdPerMillionTokens });
export const estimateModelCost = (provider: ProviderId, model: string, inputTokens: number, outputTokens: number, budget?: ExecutionBudget | null) =>
  invoke<CostEstimateResponse>("estimate_model_cost", { provider, model, inputTokens, outputTokens, budget: budget ?? null });
export const compileAndSaveDelegationWorkflow = (prompt: string, request: { prompt: string; preferred_provider: ProviderId | null; quality: "economy" | "balanced" | "maximum"; allow_antigravity: boolean }, projectPath?: string | null) =>
  invoke<WorkflowDefinition>("compile_and_save_delegation_workflow", { prompt, request, projectPath: projectPath ?? null });
