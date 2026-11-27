import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { AgentLaunchRequest, TaskEvent, TaskSnapshot, UsageSnapshot, WorkflowDefinition } from "@orchestrator/shared-types";
import {
  forgetRemoteConnection,
  loadRemoteConnection,
  openRemoteSocket,
  pairWithHost,
  remoteFetch,
  type RemoteConnection,
  type RemoteEnvelope,
} from "../lib/remote";

export type RemoteWorkflowExecution = {
  run_id: string; workflow_id: string; workflow_name: string; status: string;
  started_at: string; updated_at: string;
  events: Array<{ run_id: string; workflow_id: string; node_id: string | null; event: string; status: string; at: string }>;
  result: { run_id: string; workflow_id: string; status: string; nodes: Array<{ node_id: string; task_id: string | null; status: string; output: string; error: string | null; started_at: string; finished_at: string }>; started_at: string; finished_at: string } | null;
  error: string | null;
};

export type WorkflowCheckpoint = {
  run_id: string; process_id: number; workflow: WorkflowDefinition; repository: string; initial_prompt: string;
  completed_nodes: Array<{ node_id: string; status: string; output: string; error: string | null }>;
  status: string; started_at: string; updated_at: string; recovery_note: string | null;
};

export type ApprovalRequest = {
  id: string; task_id: string; provider: string; tool_name: string;
  action: "read" | "write" | "execute" | "network" | "destructive";
  summary: string; input_preview: string; status: "pending" | "approved" | "denied" | "expired";
  created_at: string; expires_at: string; decided_at: string | null; decided_by: string | null;
};

export type ManagedSession = {
  id: string; provider: "claude_code" | "codex" | "antigravity"; external_session_id: string | null;
  cwd: string; model: string | null; status: string;
  recovery_mode: "native_resume" | "metadata_only" | "unsupported"; recovery_note: string;
  started_at: string; updated_at: string; last_error: string | null;
};

type ConnectionStatus = "loading" | "disconnected" | "connecting" | "connected" | "reconnecting";

type RemoteContextValue = {
  connection: RemoteConnection | null;
  connectionStatus: ConnectionStatus;
  tasks: TaskSnapshot[];
  usage: UsageSnapshot | null;
  workflows: WorkflowDefinition[];
  workflowExecutions: RemoteWorkflowExecution[];
  workflowCheckpoints: WorkflowCheckpoint[];
  approvals: ApprovalRequest[];
  sessions: ManagedSession[];
  events: TaskEvent[];
  lastSequence: number | null;
  error: string | null;
  pairHost: (payload: string, deviceName: string) => Promise<void>;
  disconnect: () => Promise<void>;
  refresh: () => Promise<void>;
  launchTask: (request: AgentLaunchRequest) => Promise<string>;
  cancelTask: (taskId: string) => Promise<void>;
  decideApproval: (id: string, approve: boolean) => Promise<void>;
  resumeSession: (id: string, prompt: string) => Promise<string>;
  sendSessionMessage: (id: string, prompt: string) => Promise<void>;
  stopSession: (id: string) => Promise<void>;
  startWorkflowRemote: (workflowId: string, repository: string, initialPrompt: string) => Promise<string>;
  cancelWorkflowRemote: (runId: string) => Promise<void>;
};

const RemoteContext = createContext<RemoteContextValue | null>(null);

function upsertTask(current: TaskSnapshot[], incoming: TaskSnapshot): TaskSnapshot[] {
  const index = current.findIndex((task) => task.task_id === incoming.task_id);
  if (index === -1) return [incoming, ...current].slice(0, 500);
  const next = [...current];
  next[index] = incoming;
  return next;
}

export function RemoteProvider({ children }: { children: React.ReactNode }) {
  const [connection, setConnection] = useState<RemoteConnection | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("loading");
  const [tasks, setTasks] = useState<TaskSnapshot[]>([]);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [workflowExecutions, setWorkflowExecutions] = useState<RemoteWorkflowExecution[]>([]);
  const [workflowCheckpoints, setWorkflowCheckpoints] = useState<WorkflowCheckpoint[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [sessions, setSessions] = useState<ManagedSession[]>([]);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [lastSequence, setLastSequence] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const shouldReconnectRef = useRef(false);
  const lastSequenceRef = useRef<number | null>(null);

  const applyTaskEvent = useCallback((event: TaskEvent) => {
    setEvents((current) => [...current, event].slice(-2500));
    setTasks((current) => current.map((task) => {
      if (task.task_id !== event.task_id) return task;
      const payload = event.payload;
      if (payload.type === "state_changed") return { ...task, status: payload.data.status };
      if (payload.type === "file_changed") return { ...task, current_file: payload.data.path, last_file_change_at: event.emitted_at };
      if (payload.type === "error") return { ...task, last_error: payload.data.message };
      if (payload.type === "exited") return { ...task, exit_code: payload.data.code };
      return task;
    }));
  }, []);

  const handleEnvelope = useCallback((message: RemoteEnvelope) => {
    const data = (message.data ?? {}) as Record<string, any>;
    switch (message.type) {
      case "authenticated":
        setConnectionStatus("connected");
        reconnectAttemptRef.current = 0;
        setError(null);
        break;
      case "snapshot":
        setTasks(Array.isArray(data.tasks) ? data.tasks as TaskSnapshot[] : []);
        setUsage(data.usage ?? null);
        if (typeof data.sequence === "number") {
          lastSequenceRef.current = data.sequence;
          setLastSequence(data.sequence);
        }
        break;
      case "replay": {
        const entries = Array.isArray(data.events) ? data.events : [];
        for (const item of entries) {
          if (item?.event) applyTaskEvent(item.event as TaskEvent);
          if (typeof item?.sequence === "number") {
            lastSequenceRef.current = Math.max(lastSequenceRef.current ?? 0, item.sequence);
          }
        }
        if (typeof data.high_water === "number") lastSequenceRef.current = Math.max(lastSequenceRef.current ?? 0, data.high_water);
        setLastSequence(lastSequenceRef.current);
        break;
      }
      case "event": {
        const item = data.item;
        if (item?.event) applyTaskEvent(item.event as TaskEvent);
        if (typeof item?.sequence === "number") {
          lastSequenceRef.current = Math.max(lastSequenceRef.current ?? 0, item.sequence);
          setLastSequence(lastSequenceRef.current);
        }
        break;
      }
      case "usage":
        if (data.usage) setUsage(data.usage as UsageSnapshot);
        break;
      case "workflow_event": {
        const event = data.event as RemoteWorkflowExecution["events"][number] | undefined;
        if (event?.run_id) setWorkflowExecutions((current) => current.map((item) => item.run_id !== event.run_id ? item : {
          ...item, status: ["started", "cancelled", "finished"].includes(event.event) ? event.status : item.status === "queued" ? "running" : item.status,
          updated_at: event.at, events: [...item.events, event].slice(-500),
        }));
        break;
      }
      case "error":
        setError(typeof data.message === "string" ? data.message : "O Host retornou um erro de conexão.");
        break;
      default:
        break;
    }
  }, [applyTaskEvent]);

  const refresh = useCallback(async () => {
    try {
      const [taskResult, usageResult, workflowResult, executionResult, checkpointResult, approvalResult, sessionResult] = await Promise.allSettled([
        remoteFetch<TaskSnapshot[]>("/api/v1/tasks"),
        remoteFetch<UsageSnapshot>("/api/v1/usage"),
        remoteFetch<WorkflowDefinition[]>("/api/v1/workflows"),
        remoteFetch<RemoteWorkflowExecution[]>("/api/v1/workflow-executions"),
        remoteFetch<WorkflowCheckpoint[]>("/api/v1/workflow-checkpoints"),
        remoteFetch<ApprovalRequest[]>("/api/v1/approvals"),
        remoteFetch<ManagedSession[]>("/api/v1/sessions"),
      ]);
      if (taskResult.status === "fulfilled") setTasks(taskResult.value);
      if (usageResult.status === "fulfilled") setUsage(usageResult.value);
      if (workflowResult.status === "fulfilled") setWorkflows(workflowResult.value);
      if (executionResult.status === "fulfilled") setWorkflowExecutions(executionResult.value);
      if (checkpointResult.status === "fulfilled") setWorkflowCheckpoints(checkpointResult.value);
      if (approvalResult.status === "fulfilled") setApprovals(approvalResult.value);
      if (sessionResult.status === "fulfilled") setSessions(sessionResult.value);
      const failures = [taskResult, usageResult, workflowResult, executionResult, checkpointResult, approvalResult, sessionResult].filter((item) => item.status === "rejected") as PromiseRejectedResult[];
      if (failures.length === 7) throw failures[0].reason;
      setError(failures.length ? `Alguns dados não puderam ser atualizados: ${String(failures[0].reason)}` : null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    }
  }, []);

  const connectSocket = useCallback(async () => {
    if (!shouldReconnectRef.current) return;
    setConnectionStatus(reconnectAttemptRef.current > 0 ? "reconnecting" : "connecting");
    try {
      const socket = await openRemoteSocket(lastSequenceRef.current, handleEnvelope, () => {
        if (!shouldReconnectRef.current) return;
        setConnectionStatus("reconnecting");
        const attempt = Math.min(reconnectAttemptRef.current++, 8);
        const delay = Math.min(30_000, 800 * 2 ** attempt);
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = setTimeout(() => void connectSocket(), delay);
      });
      if (!shouldReconnectRef.current) {
        socket.close();
        return;
      }
      socketRef.current = socket;
      socket.onerror = () => setConnectionStatus("reconnecting");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      if (shouldReconnectRef.current) {
        const attempt = Math.min(reconnectAttemptRef.current++, 8);
        reconnectTimerRef.current = setTimeout(() => void connectSocket(), Math.min(30_000, 800 * 2 ** attempt));
      }
    }
  }, [handleEnvelope]);

  const activateConnection = useCallback(async (next: RemoteConnection) => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    socketRef.current?.close();
    socketRef.current = null;
    setConnection(next);
    shouldReconnectRef.current = true;
    setConnectionStatus("connecting");
    try { await refresh(); } catch { /* Socket retries after REST bootstrap failure. */ }
    await connectSocket();
  }, [connectSocket, refresh]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const saved = await loadRemoteConnection();
        if (cancelled) return;
        if (!saved) {
          setConnectionStatus("disconnected");
          return;
        }
        await activateConnection(saved);
      } catch (reason) {
        if (!cancelled) {
          setConnectionStatus("disconnected");
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      }
    })();
    return () => {
      cancelled = true;
      shouldReconnectRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      socketRef.current?.close();
    };
  }, [activateConnection]);

  useEffect(() => {
    if (connectionStatus !== "connected" || !connection) return;
    void refresh().catch(() => undefined);
    const timer = setInterval(() => { void refresh().catch(() => undefined); }, 15_000);
    return () => clearInterval(timer);
  }, [connectionStatus, connection, refresh]);

  const pairHost = useCallback(async (payload: string, deviceName: string) => {
    const paired = await pairWithHost(payload, deviceName);
    setEvents([]);
    lastSequenceRef.current = null;
    setLastSequence(null);
    reconnectAttemptRef.current = 0;
    await activateConnection(paired);
  }, [activateConnection]);

  const disconnect = useCallback(async () => {
    shouldReconnectRef.current = false;
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    socketRef.current?.close();
    socketRef.current = null;
    await forgetRemoteConnection();
    setConnection(null);
    setConnectionStatus("disconnected");
    setTasks([]); setUsage(null); setWorkflows([]); setWorkflowExecutions([]); setApprovals([]); setSessions([]); setEvents([]); setLastSequence(null);
    lastSequenceRef.current = null;
    setError(null);
  }, []);

  const launchTask = useCallback(async (request: AgentLaunchRequest) => {
    const result = await remoteFetch<{ task_id: string }>("/api/v1/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    await refresh();
    return result.task_id;
  }, [refresh]);

  const cancelTask = useCallback(async (taskId: string) => {
    await remoteFetch<void>(`/api/v1/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
    await refresh();
  }, [refresh]);

  const decideApproval = useCallback(async (id: string, approve: boolean) => {
    await remoteFetch<ApprovalRequest>(`/api/v1/approvals/${encodeURIComponent(id)}/decision`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approve }),
    });
    await refresh();
  }, [refresh]);

  const resumeSession = useCallback(async (id: string, prompt: string) => {
    const result = await remoteFetch<{ session_id: string }>(`/api/v1/sessions/${encodeURIComponent(id)}/resume`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt }),
    });
    await refresh();
    return result.session_id;
  }, [refresh]);

  const sendSessionMessage = useCallback(async (id: string, prompt: string) => {
    await remoteFetch<void>(`/api/v1/sessions/${encodeURIComponent(id)}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt }),
    });
    await refresh();
  }, [refresh]);

  const stopSession = useCallback(async (id: string) => {
    await remoteFetch<void>(`/api/v1/sessions/${encodeURIComponent(id)}/stop`, { method: "POST" });
    await refresh();
  }, [refresh]);

  const startWorkflowRemote = useCallback(async (workflowId: string, repository: string, initialPrompt: string) => {
    const result = await remoteFetch<RemoteWorkflowExecution>(`/api/v1/workflows/${encodeURIComponent(workflowId)}/run`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repository, initial_prompt: initialPrompt }),
    });
    setWorkflowExecutions((current) => [result, ...current.filter((item) => item.run_id !== result.run_id)]);
    return result.run_id;
  }, []);

  const cancelWorkflowRemote = useCallback(async (runId: string) => {
    await remoteFetch<void>(`/api/v1/workflow-executions/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
    await refresh();
  }, [refresh]);

  const value = useMemo<RemoteContextValue>(() => ({
    connection, connectionStatus, tasks, usage, workflows, workflowExecutions, workflowCheckpoints, approvals, sessions, events, lastSequence, error,
    pairHost, disconnect, refresh, launchTask, cancelTask, decideApproval, resumeSession, sendSessionMessage, stopSession, startWorkflowRemote, cancelWorkflowRemote,
  }), [connection, connectionStatus, tasks, usage, workflows, workflowExecutions, workflowCheckpoints, approvals, sessions, events, lastSequence, error, pairHost, disconnect, refresh, launchTask, cancelTask, decideApproval, resumeSession, sendSessionMessage, stopSession, startWorkflowRemote, cancelWorkflowRemote]);

  return <RemoteContext.Provider value={value}>{children}</RemoteContext.Provider>;
}

export function useRemote() {
  const context = useContext(RemoteContext);
  if (!context) throw new Error("useRemote precisa estar dentro de RemoteProvider.");
  return context;
}
