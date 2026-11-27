import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Activity, Bot, BrainCircuit, ChevronRight, Command, GitBranch, History, Home, Play, RefreshCw, ShieldCheck, Smartphone, Sparkles, Workflow as WorkflowIcon } from "lucide-react";
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
type NavItem = { id: Page; label: string; hint: string; icon: ReactNode };
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
  const [showAdvanced, setShowAdvanced] = useState(false);

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

  const mainNav: NavItem[] = [
    { id: "tasks", label: "Início", hint: "Peça algo a uma IA e acompanhe o andamento", icon: <Home size={16} /> },
    { id: "approvals", label: "Pedidos de permissão", hint: "A IA quer fazer algo e precisa do seu OK", icon: <ShieldCheck size={16} /> },
    { id: "router", label: "Me ajude a escolher", hint: "Descreva a tarefa e indicamos a melhor IA", icon: <Sparkles size={16} /> },
    { id: "workflows", label: "Automações", hint: "Várias IAs trabalhando em sequência", icon: <WorkflowIcon size={16} /> },
    { id: "remote", label: "Usar no celular", hint: "Conecte o app do celular por QR Code", icon: <Smartphone size={16} /> },
  ];
  const advancedNav: NavItem[] = [
    { id: "providers", label: "IAs instaladas", hint: "Quais IAs o Psylium encontrou no seu PC", icon: <Bot size={16} /> },
    { id: "sessions", label: "Conversas abertas", hint: "Saída ao vivo de cada IA rodando", icon: <Activity size={16} /> },
    { id: "run-history", label: "Histórico de automações", hint: "Resultados das automações já rodadas", icon: <History size={16} /> },
    { id: "intelligence", label: "Gastos e memória", hint: "Quanto cada IA gastou e o que ela lembra", icon: <BrainCircuit size={16} /> },
    { id: "worktrees", label: "Cópias do projeto", hint: "Cada IA trabalha numa cópia separada do projeto (Git)", icon: <GitBranch size={16} /> },
    { id: "claude", label: "Claude (direto)", hint: "Conversar só com o Claude Code", icon: <Bot size={16} /> },
    { id: "codex", label: "Codex (direto)", hint: "Conversar só com o Codex", icon: <Bot size={16} /> },
  ];
  const current = [...mainNav, ...advancedNav].find((item) => item.id === page)!;
  const navButton = (item: NavItem) => <button key={item.id} onClick={() => setPage(item.id)} title={item.hint} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition ${page === item.id ? "bg-slate-700 text-white" : "text-slate-400 hover:bg-panel hover:text-white"}`}>{item.icon}<span>{item.label}</span></button>;

  return (
    <main className="flex min-h-screen bg-canvas text-zinc-100">
      <aside className="sticky top-0 flex h-screen w-64 shrink-0 flex-col gap-1 overflow-y-auto border-r border-line p-4">
        <div className="mb-5 flex items-center gap-3 px-2"><div className="rounded-xl border border-line bg-panel p-2 text-accent"><Command size={20} /></div><div><p className="text-sm font-semibold tracking-wide">Psylium</p><p className="text-[11px] text-muted">Suas IAs num lugar só</p></div></div>
        {mainNav.map(navButton)}
        <button onClick={() => setShowAdvanced((open) => !open)} className="mt-4 flex items-center gap-2 px-3 py-2 text-[11px] uppercase tracking-wide text-muted hover:text-white"><ChevronRight size={12} className={`transition ${showAdvanced ? "rotate-90" : ""}`} />Avançado</button>
        {(showAdvanced || advancedNav.some((item) => item.id === page)) && advancedNav.map(navButton)}
        <div className="mt-auto space-y-2 px-3 pt-4 text-xs text-muted">
          <p className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${desktopBridgeAvailable ? "bg-emerald-400" : "bg-amber-400"}`} />{desktopBridgeAvailable ? "Pronto" : "Abra pelo app instalado"}</p>
          <p className="flex items-center gap-2"><Activity size={13} />{activeCount === 0 ? "Nenhuma IA trabalhando" : `${activeCount} IA(s) trabalhando`}</p>
        </div>
      </aside>

      <div className="min-w-0 flex-1 p-6">
        <div className="mb-5 flex items-start justify-between gap-4"><div><h1 className="text-lg font-semibold">{current.label}</h1><p className="text-sm text-muted">{current.hint}</p></div><button onClick={() => void refresh()} className="rounded-lg border border-line p-2 hover:bg-panel" title="Atualizar"><RefreshCw size={14} /></button></div>
        {page === "router" && <AgentRouter />}
        {page === "intelligence" && <IntelligenceConsole />}
        {page === "tasks" && <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
          <TaskBoard tasks={tasks} events={events} onStop={(id) => void stop(id)} />
          <aside className="order-first h-fit space-y-4 xl:sticky xl:top-6">
            <div className="rounded-xl border border-line bg-panel p-5"><div className="mb-4 flex items-center gap-2"><Play size={15} className="text-accent" /><h2 className="text-sm font-semibold">Pedir algo a uma IA</h2></div>
              <Field label="1. Qual IA?"><select value={provider} onChange={(event) => setProvider(event.target.value as ProviderId)} className={inputClass}><option value="claude_code">Claude Code</option><option value="codex">Codex</option><option value="antigravity">Antigravity</option></select></Field>
              <Field label="2. Em qual pasta do seu PC ela vai trabalhar?"><input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="Ex.: C:\Projetos\meu-app" className={inputClass} /></Field>
              <Field label="3. O que você quer que ela faça?"><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={6} placeholder="Ex.: Crie uma página de login simples" className={`${inputClass} resize-y`} /></Field>
              <details className="mb-2 text-xs text-muted"><summary className="cursor-pointer py-1 hover:text-white">Opções avançadas</summary>
                <Field label="Modelo (deixe vazio para usar o padrão)"><input value={model} onChange={(event) => setModel(event.target.value)} placeholder="Padrão" className={inputClass} /></Field>
                <Field label="Esforço (mais esforço = mais lento e mais caro)"><select value={effort} onChange={(event) => setEffort(event.target.value)} className={inputClass}>{effortOptions.map((option) => <option key={option}>{option}</option>)}</select></Field>
              </details>
              <button disabled={!desktopBridgeAvailable || busy || !prompt.trim() || !cwd.trim()} onClick={() => void start()} className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-3 text-sm font-semibold text-zinc-950 transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"><Play size={14} />{busy ? "Iniciando..." : "Começar"}</button>
              {!desktopBridgeAvailable && <p className="mt-3 text-[11px] text-amber-300">Abra pelo app instalado para usar as IAs.</p>}
              {error && <p className="mt-3 break-words text-xs text-rose-300">{error}</p>}
            </div>
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
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="block"><span className="text-xs text-slate-300">{label}</span>{children}</label>; }
