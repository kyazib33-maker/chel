import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Activity, CircleStop, Clock3, FileCode2, ListTree, SplitSquareVertical, TerminalSquare, XCircle } from "lucide-react";
import type { TaskEvent, TaskSnapshot, TaskStatus } from "../../lib/tauri";

const columns: Array<{ id: string; title: string; statuses: TaskStatus[]; accent: string }> = [
  { id: "queue", title: "Na fila", statuses: ["queued", "starting"], accent: "text-amber-200" },
  { id: "running", title: "Executando", statuses: ["running", "cancelling"], accent: "text-emerald-200" },
  { id: "approval", title: "Esperando seu OK", statuses: ["awaiting_approval"], accent: "text-violet-200" },
  { id: "completed", title: "Concluído", statuses: ["succeeded", "cancelled"], accent: "text-sky-200" },
  { id: "error", title: "Erro / Cota", statuses: ["failed", "quota_exceeded"], accent: "text-rose-200" },
];

const providerLabel = { claude_code: "Claude Code", codex: "Codex CLI", antigravity: "Antigravity" };
const statusLabel: Record<TaskStatus, string> = {
  queued: "Na fila", starting: "Iniciando", running: "Executando", cancelling: "Interrompendo",
  awaiting_approval: "Esperando seu OK", succeeded: "Concluído", failed: "Erro", quota_exceeded: "Cota atingida", cancelled: "Cancelado",
};

function elapsed(task: TaskSnapshot, now: number): string {
  if (!task.started_at) return "Aguardando início";
  const end = task.finished_at ? new Date(task.finished_at).getTime() : now;
  const seconds = Math.max(0, Math.floor((end - new Date(task.started_at).getTime()) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  return hours > 0 ? `${hours}h ${minutes}m ${remaining}s` : minutes > 0 ? `${minutes}m ${remaining}s` : `${remaining}s`;
}

function taskOutput(events: TaskEvent[], taskId: string) {
  return events.filter((event) => event.task_id === taskId && event.payload.type === "output").slice(-12);
}

export default function TaskBoard({ tasks, events, onStop }: { tasks: TaskSnapshot[]; events: TaskEvent[]; onStop: (id: string) => void }) {
  const [now, setNow] = useState(Date.now());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [splitIds, setSplitIds] = useState<string[]>([]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const activeCount = useMemo(() => tasks.filter((task) => ["queued", "starting", "running", "cancelling", "awaiting_approval"].includes(task.status)).length, [tasks]);

  function toggleSplit(id: string) {
    setSplitIds((current) => current.includes(id) ? current.filter((value) => value !== id) : current.length >= 4 ? [...current.slice(1), id] : [...current, id]);
  }

  return (
    <div className="space-y-5">

      <div className="grid gap-3 sm:grid-cols-3"><Metric label="Pedidos feitos" value={String(tasks.length)} icon={<ListTree size={15} />} /><Metric label="Em andamento" value={String(activeCount)} icon={<Activity size={15} />} /><Metric label="Mensagens das IAs" value={String(events.length)} icon={<TerminalSquare size={15} />} /></div>

      <div className="grid gap-3 2xl:grid-cols-5 xl:grid-cols-3 md:grid-cols-2">
        {columns.map((column) => {
          const group = tasks.filter((task) => column.statuses.includes(task.status));
          return <section key={column.id} className="min-h-[260px] rounded-xl border border-line bg-[#101720]">
            <div className="flex items-center justify-between border-b border-line px-3 py-3"><h2 className={`text-xs font-semibold ${column.accent}`}>{column.title}</h2><span className="rounded-md bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400">{group.length}</span></div>
            <div className="space-y-2 p-2.5">{group.length === 0 ? <p className="px-2 py-5 text-center text-[10px] text-slate-600">Nenhuma tarefa</p> : group.map((task) => {
              const lines = taskOutput(events, task.task_id);
              const selectedForSplit = splitIds.includes(task.task_id);
              return <article key={task.task_id} className={`rounded-lg border bg-[#0b1119] p-3 ${selectedForSplit ? "border-cyan-300/50" : "border-slate-800"}`}>
                <div className="flex items-start justify-between gap-2"><div className="min-w-0"><p className="truncate text-xs font-semibold text-slate-100">{task.display_name}</p><p className="mt-1 truncate text-[10px] text-cyan-200">{task.provider ? providerLabel[task.provider] : task.program}</p></div><span className="shrink-0 text-[9px] text-slate-500">{statusLabel[task.status]}</span></div>
                <p className="mt-2 truncate text-[10px] text-slate-500">{task.model || "Modelo padrão"} · {task.effort || "Effort padrão"}</p>
                <div className="mt-2 flex items-center gap-1.5 text-[10px] text-slate-400"><Clock3 size={11} />{elapsed(task, now)}</div>
                <div className="mt-2 flex items-center gap-1.5 text-[9px] text-slate-500"><FileCode2 size={10} />{task.current_file ? task.current_file : "Aguardando alteração de arquivo"}</div>
                {task.last_error && <p className="mt-2 break-words text-[10px] text-rose-300">{task.last_error}</p>}
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <button onClick={() => setExpanded((current) => current === task.task_id ? null : task.task_id)} className="rounded-md border border-slate-700 px-2 py-1 text-[9px] text-slate-400 hover:text-slate-100">{expanded === task.task_id ? "Fechar log" : "Abrir log"}</button>
                  <button onClick={() => toggleSplit(task.task_id)} className={`flex items-center gap-1 rounded-md border px-2 py-1 text-[9px] ${selectedForSplit ? "border-cyan-300/40 text-cyan-200" : "border-slate-700 text-slate-400"}`}><SplitSquareVertical size={10} />{selectedForSplit ? "No split" : "Split view"}</button>
                  {["queued", "starting", "running", "awaiting_approval"].includes(task.status) && <button onClick={() => onStop(task.task_id)} className="rounded-md border border-rose-500/20 px-2 py-1 text-[9px] text-rose-300 hover:bg-rose-500/10"><CircleStop size={11} /></button>}
                </div>
                {expanded === task.task_id && <LogLines events={lines} />}
              </article>;
            })}</div>
          </section>;
        })}
      </div>

      {splitIds.length > 0 && <section className="rounded-xl border border-line bg-panel">
        <div className="flex items-center justify-between border-b border-line px-4 py-3"><div><h2 className="text-xs font-semibold">Ver lado a lado</h2><p className="mt-1 text-[10px] text-muted">Escolha até 4 tarefas para acompanhar ao mesmo tempo.</p></div><button onClick={() => setSplitIds([])} className="text-[10px] text-slate-500 hover:text-slate-100">Limpar seleção</button></div>
        <div className={`grid gap-2 p-3 ${splitIds.length === 1 ? "grid-cols-1" : splitIds.length === 2 ? "md:grid-cols-2" : "md:grid-cols-2 xl:grid-cols-4"}`}>{splitIds.map((id) => {
          const task = tasks.find((item) => item.task_id === id);
          if (!task) return null;
          return <div key={id} className="min-w-0 rounded-lg border border-slate-800 bg-[#0b1119] p-3"><div className="mb-2 flex items-center justify-between gap-2"><p className="truncate text-[11px] font-semibold">{task.display_name}</p><button onClick={() => toggleSplit(id)} className="text-slate-600 hover:text-rose-300"><XCircle size={13} /></button></div><p className="mb-2 text-[9px] text-cyan-200">{task.provider ? providerLabel[task.provider] : task.program} · {statusLabel[task.status]}</p><LogLines events={taskOutput(events, id)} compact /></div>;
        })}</div>
      </section>}

      <section className="rounded-xl border border-line bg-panel"><div className="border-b border-line px-4 py-3"><h2 className="text-xs font-semibold">Timeline global</h2></div><div className="max-h-72 overflow-auto p-3 font-mono text-[10px]">{events.length === 0 ? <p className="p-4 text-center text-slate-600">Os eventos dos CLIs aparecerão aqui.</p> : events.slice(-100).reverse().map((event) => {
        const payload = event.payload;
        const line = payload.type === "output" ? payload.data.line : payload.type === "error" ? payload.data.message : payload.type === "state_changed" ? payload.data.status : payload.type === "file_changed" ? payload.data.path : `exit code ${payload.data.code ?? "n/a"}`;
        return <p key={`${event.task_id}-${event.sequence}`} className="flex gap-2 border-b border-slate-800/70 py-1.5"><span className="shrink-0 text-slate-600">{new Date(event.emitted_at).toLocaleTimeString()}</span><span className="shrink-0 text-cyan-200">{event.task_id.slice(0, 8)}</span><span className={`shrink-0 ${payload.type === "error" || (payload.type === "output" && payload.data.stream === "stderr") ? "text-rose-300" : "text-slate-500"}`}>{payload.type}</span><span className="min-w-0 break-all text-slate-300">{line}</span></p>;
      })}</div></section>
    </div>
  );
}

function LogLines({ events, compact = false }: { events: TaskEvent[]; compact?: boolean }) {
  return <div className={`mt-2 max-h-44 overflow-auto rounded-md border border-slate-800 bg-black/30 p-2 font-mono text-[9px] ${compact ? "min-h-24" : ""}`}>{events.length === 0 ? <p className="text-slate-600">Sem saída registrada.</p> : events.map((event) => {
    if (event.payload.type !== "output") return null;
    return <p key={`${event.sequence}`} className={`whitespace-pre-wrap break-words py-0.5 ${event.payload.data.stream === "stderr" ? "text-rose-300" : "text-slate-300"}`}>{event.payload.data.line}</p>;
  })}</div>;
}
function Metric({ label, value, icon }: { label: string; value: string; icon: ReactNode }) { return <div className="rounded-xl border border-line bg-panel p-4"><div className="flex items-center gap-2 text-muted">{icon}<span className="text-xs">{label}</span></div><p className="mt-2 text-2xl font-semibold">{value}</p></div>; }
