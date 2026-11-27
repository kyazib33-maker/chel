import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Activity, Bot, BrainCircuit, Command, GitBranch, Play, RefreshCw, ShieldCheck, Smartphone, Workflow as WorkflowIcon } from "lucide-react";
import TaskBoard from "./features/tasks/TaskBoard";
import WorkflowBuilder from "./features/workflows/WorkflowBuilder";
import WorktreePanel from "./features/worktrees/WorktreePanel";
import RemotePanel from "./features/remote/RemotePanel";
import ApprovalsPanel from "./features/approvals/ApprovalsPanel";
import CodexNativePanel from "./features/approvals/CodexNativePanel";
import ClaudeNativePanel from "./features/approvals/ClaudeNativePanel";
import SessionCenter from "./features/sessions/SessionCenter";
import ProviderCatalog from "./features/sessions/ProviderCatalog";
import AgentRouter from "./features/routing/AgentRouter";
import IntelligenceConsole from "./features/intelligence/IntelligenceConsole";
import WorkflowRunHistory from "./features/workflows/WorkflowRunHistory";
import {
  cancelTask, desktopBridgeAvailable, launchAgent, listTasks, onTaskEvent,
  type ProviderId, type TaskEvent, type TaskSnapshot,
} from "./lib/tauri";

const providerLabel: Record<ProviderId, string> = {
  claude_code: "Claude Code", codex: "Codex CLI", antigravity: "Antigravity",
};
type Page = "router" | "tasks" | "workflows" | "run-history" | "worktrees" | "approvals" | "codex" | "claude" | "sessions" | "providers" | "remote" | "intelligence";

export default function App() {
  const [page, setPage] = useState<Page>("tasks");
  const [tasks, setTasks] = useState<TaskSnapshot[]>([]);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [provider, setProvider] = useState<ProviderId>("claude_code");
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("medium");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeCount = useMemo(() => tasks.filter((task) => ["queued", "starting", "running", "cancelling", "awaiting_approval"].includes(task.status)).length, [tasks]);
  const effortOptions = provider === "codex" ? ["low", "medium", "high", "xhigh"] : provider === "claude_code" ? ["low", "medium", "high", "max"] : ["low", "medium", "high"];

  async function refresh() {
    if (!desktopBridgeAvailable) return;
    try { setTasks(await listTasks()); }
    catch (reason) { setError(String(reason)); }
  }

  useEffect(() => {
    if (!effortOptions.includes(effort)) setEffort("medium");
  }, [provider]);

  useEffect(() => {
    void refresh();
    if (!desktopBridgeAvailable) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void onTaskEvent((event) => {
      setEvents((current) => [...current.slice(-2499), event]);
      setTasks((current) => current.map((task) => {
        if (task.task_id !== event.task_id) return task;
        switch (event.payload.type) {
          case "state_changed":
            return {
              ...task,
              status: event.payload.data.status,
              started_at: task.started_at ?? (event.payload.data.status === "running" ? event.emitted_at : null),
              finished_at: ["succeeded", "failed", "cancelled", "quota_exceeded"].includes(event.payload.data.status) ? event.emitted_at : task.finished_at,
            };
          case "file_changed":
            return { ...task, current_file: event.payload.data.path, last_file_change_at: event.emitted_at };
          case "error":
            return { ...task, last_error: event.payload.data.message };
          case "exited":
            return { ...task, exit_code: event.payload.data.code, finished_at: task.finished_at ?? event.emitted_at };
          default:
            return task;
        }
      }));
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    }).catch((reason: unknown) => setError(String(reason)));
    // Reconcile occasionally in case a native broadcast buffer overflowed or
    // the WebView was suspended while events were emitted. This is deliberately
    // independent of each stdout/stderr line to avoid IPC polling storms.
    const reconciliation = window.setInterval(() => { void refresh(); }, 5000);
    return () => {
      disposed = true;
      window.clearInterval(reconciliation);
      unlisten?.();
    };
  }, []);

  async function start() {
    if (!prompt.trim() || !cwd.trim()) return;
    setBusy(true); setError(null);
    try {
      await launchAgent({ provider, prompt, cwd, model: model.trim() || null, effort, display_name: `${providerLabel[provider]} · tarefa` });
      setPrompt("");
      await refresh();
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  async function stop(taskId: string) {
    try { await cancelTask(taskId); await refresh(); }
    catch (reason) { setError(String(reason)); }
  }

  const navItems: Array<{ id: Page; label: string; icon: ReactNode }> = [
    { id: "router", label: "Roteador IA", icon: <Bot size={15} /> },
    { id: "intelligence", label: "Memória & Custos", icon: <BrainCircuit size={15} /> },
    { id: "tasks", label: "Task Board", icon: <Bot size={15} /> },
    { id: "workflows", label: "Workflows", icon: <WorkflowIcon size={15} /> },
    { id: "run-history", label: "Execuções", icon: <Activity size={15} /> },
    { id: "worktrees", label: "Git Worktrees", icon: <GitBranch size={15} /> },
    { id: "approvals", label: "Aprovações", icon: <ShieldCheck size={15} /> },
    { id: "codex", label: "Codex nativo", icon: <Bot size={15} /> },
    { id: "claude", label: "Claude nativo", icon: <Bot size={15} /> },
    { id: "sessions", label: "Sessões", icon: <Activity size={15} /> },
    { id: "providers", label: "Provedores", icon: <Bot size={15} /> },
    { id: "remote", label: "Remote & Usage", icon: <Smartphone size={15} /> },
  ];

  return (
    <main className="min-h-screen bg-canvas text-zinc-100">
      <header className="sticky top-0 z-20 border-b border-line bg-canvas/95 px-6 py-4 backdrop-blur">
        <div className="mx-auto flex max-w-[1700px] flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3"><div className="rounded-xl border border-line bg-panel p-2 text-accent"><Command size={20} /></div><div><p className="text-sm font-semibold tracking-wide">PSYLIUM</p><p className="text-[10px] text-muted">Rust Host · Tauri v2 · Etapa 20–30 · 1.0</p></div></div>
          <nav className="flex items-center gap-1 rounded-xl border border-line bg-panel p-1">{navItems.map((item) => <button key={item.id} onClick={() => setPage(item.id)} className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs transition ${page === item.id ? "bg-slate-700 text-white" : "text-slate-400 hover:text-white"}`}>{item.icon}{item.label}</button>)}</nav>
          <div className="flex items-center gap-4 text-xs text-muted"><span className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${desktopBridgeAvailable ? "bg-emerald-400" : "bg-amber-400"}`} />{desktopBridgeAvailable ? "Host Tauri conectado" : "Modo navegador"}</span><span className="flex items-center gap-2"><Activity size={14} />{activeCount} ativos</span><button onClick={() => void refresh()} className="rounded-lg border border-line p-2 hover:bg-panel" title="Atualizar tarefas"><RefreshCw size={14} /></button></div>
        </div>
      </header>

      <div className="mx-auto max-w-[1700px] p-6">
        {page === "router" && <AgentRouter />}
        {page === "intelligence" && <IntelligenceConsole />}
        {page === "tasks" && <div className="grid gap-5 2xl:grid-cols-[minmax(0,1fr)_340px]">
          <TaskBoard tasks={tasks} events={events} onStop={(id) => void stop(id)} />
          <aside className="h-fit space-y-4 2xl:sticky 2xl:top-24">
            <div className="rounded-xl border border-line bg-panel p-5"><div className="mb-4 flex items-center gap-2"><Play size={15} className="text-accent" /><h2 className="text-xs font-semibold">Disparo rápido</h2></div>
              <Field label="CLI"><select value={provider} onChange={(event) => setProvider(event.target.value as ProviderId)} className={inputClass}><option value="claude_code">Claude Code</option><option value="codex">Codex CLI</option><option value="antigravity">Antigravity</option></select></Field>
              <Field label="Diretório de trabalho absoluto"><input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="C:\Projetos\meu-app" className={inputClass} /></Field>
              <Field label="Modelo"><input value={model} onChange={(event) => setModel(event.target.value)} placeholder="Usar modelo padrão" className={inputClass} /></Field>
              <Field label="Effort"><select value={effort} onChange={(event) => setEffort(event.target.value)} className={inputClass}>{effortOptions.map((option) => <option key={option}>{option}</option>)}</select></Field>
              <Field label="Prompt"><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={6} placeholder="Descreva a tarefa para o agente..." className={`${inputClass} resize-y`} /></Field>
              <button disabled={!desktopBridgeAvailable || busy || !prompt.trim() || !cwd.trim()} onClick={() => void start()} className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-3 text-xs font-semibold text-zinc-950 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"><Play size={14} />{busy ? "Iniciando..." : "Iniciar agente"}</button>
              {!desktopBridgeAvailable && <p className="mt-3 text-[10px] text-amber-300">Abra pelo Tauri para executar processos locais.</p>}
              {error && <p className="mt-3 break-words text-xs text-rose-300">{error}</p>}
            </div>
            <div className="rounded-xl border border-line bg-panel p-5"><h2 className="text-xs font-semibold">Fundação</h2><div className="mt-3 space-y-2 text-[10px] text-slate-400"><StatusLine done text="Pool paralelo Tokio" /><StatusLine done text="Streaming e cancelamento" /><StatusLine done text="Kanban e Split View" /><StatusLine done text="Worktree manager com registro" /><StatusLine done text="Workflow visual e validação DAG" /><StatusLine text="Runner coordenado de workflows" /><StatusLine done text="REST / WebSocket remoto" /></div></div>
          </aside>
        </div>}
        {page === "workflows" && <WorkflowBuilder />}
        {page === "run-history" && <WorkflowRunHistory />}
        {page === "worktrees" && <WorktreePanel />}
        {page === "approvals" && <ApprovalsPanel />}
        {page === "codex" && <CodexNativePanel />}
        {page === "claude" && <ClaudeNativePanel />}
        {page === "sessions" && <SessionCenter />}
        {page === "providers" && <ProviderCatalog />}
        {page === "remote" && <RemotePanel />}
      </div>
    </main>
  );
}

const inputClass = "mb-3 mt-1.5 w-full rounded-lg border border-line bg-canvas px-3 py-2.5 text-xs text-zinc-100 outline-none focus:border-accent";
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="block"><span className="text-[10px] text-muted">{label}</span>{children}</label>; }
function StatusLine({ done = false, text }: { done?: boolean; text: string }) { return <p className="flex items-center gap-2"><span className={done ? "text-emerald-400" : "text-slate-700"}>{done ? "✓" : "○"}</span>{text}</p>; }
