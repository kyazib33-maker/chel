export type ProviderId = "claude_code" | "codex" | "antigravity";

export type TaskStatus =
  | "queued"
  | "starting"
  | "running"
  | "cancelling"
  | "awaiting_approval"
  | "succeeded"
  | "failed"
  | "quota_exceeded"
  | "cancelled";

export interface TaskSnapshot {
  task_id: string;
  provider: ProviderId | null;
  display_name: string;
  model: string | null;
  effort: string | null;
  program: string;
  cwd: string;
  current_file: string | null;
  last_file_change_at: string | null;
  status: TaskStatus;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  last_error: string | null;
}

export interface AgentLaunchRequest {
  provider: ProviderId;
  prompt: string;
  cwd: string;
  model?: string | null;
  effort?: string | null;
  display_name?: string | null;
}

export type TaskEventPayload =
  | { type: "state_changed"; data: { status: TaskStatus } }
  | { type: "output"; data: { stream: "stdout" | "stderr"; line: string } }
  | { type: "file_changed"; data: { path: string } }
  | { type: "exited"; data: { code: number | null } }
  | { type: "error"; data: { message: string } };

export interface TaskEvent {
  task_id: string;
  sequence: number;
  emitted_at: string;
  payload: TaskEventPayload;
}

export type ContextMode = "none" | "summary" | "full_output" | "files_only";
export type WorktreeMode = "isolated" | "shared" | "inherit";

export interface NodePosition { x: number; y: number }

export interface AgentNodeDefinition {
  id: string;
  name: string;
  role: string;
  prompt: string;
  provider: ProviderId;
  model: string | null;
  effort: string | null;
  context_mode: ContextMode;
  worktree_mode: WorktreeMode;
  position: NodePosition;
}

export interface WorkflowEdgeDefinition {
  id: string;
  source: string;
  target: string;
  pass_context: boolean;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  nodes: AgentNodeDefinition[];
  edges: WorkflowEdgeDefinition[];
  created_at: string;
  updated_at: string;
}

export interface WorkflowValidation {
  valid: boolean;
  errors: string[];
  execution_levels: string[][];
}

export interface CreateWorktreeRequest {
  repository: string;
  name: string;
  branch_name: string;
  base_ref: string;
}

export interface WorktreeInfo {
  id: string;
  repository: string;
  path: string;
  name: string;
  branch_name: string;
  base_ref: string;
  created_at: string;
  present: boolean;
  clean: boolean;
  modified_files: number;
  untracked_files: number;
  staged_files: number;
}

export interface RemoteServerInfo {
  running: boolean;
  port: number;
  lan_enabled: boolean;
  endpoints: string[];
  security_notice: string;
}

export interface PairingInfo {
  version: number;
  endpoints: string[];
  pairing_code: string;
  expires_at: string;
  qr_payload: string;
}

export interface PairedDevice {
  id: string;
  name: string;
  created_at: string;
  last_seen_at: string | null;
}

export interface TokenTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

export type QuotaStatus = "normal" | "rate_limited" | "quota_exceeded" | "unknown";

export interface ProviderUsage {
  provider: ProviderId;
  historical: TokenTotals;
  live: TokenTotals;
  sessions_scanned: number;
  execution_seconds: number;
  quota_status: QuotaStatus;
  historical_available: boolean;
  live_available: boolean;
  official_quota_available: boolean;
  notes: string[];
}

export interface UsageSnapshot {
  generated_at: string;
  providers: ProviderUsage[];
}
