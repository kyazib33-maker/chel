import { useEffect, useState } from "react";
import { Check, Loader2, RefreshCw } from "lucide-react";
import { brand, effortName, ProviderMark } from "../../lib/providers";
import type { ProviderId, TaskSnapshot } from "../../lib/tauri";
import { finished } from "./engine";
import type { useChats } from "./useChats";

type Hub = ReturnType<typeof useChats>;
const order: ProviderId[] = ["claude_code", "codex", "antigravity"];

function when(resets: string | null): string {
  if (!resets) return "";
  const d = new Date(resets);
  if (!Number.isNaN(d.getTime()) && /^\d{4}-/.test(resets)) return d.toLocaleString("pt-BR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return resets.replace(/\s*\(.*\)$/, "");
}
const bar = (pct: number) => pct <= 0 ? "#f43f5e" : pct < 20 ? "#f59e0b" : "#34d399";
function elapsed(from: number) { const s = Math.max(0, Math.round((Date.now() - from) / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}min ${s % 60}s`; }

export default function ActivityPanel({ hub, tasks }: { hub: Hub; tasks: TaskSnapshot[] }) {
  const [, tick] = useState(0);
  const [loading, setLoading] = useState(false);
  useEffect(() => { const t = window.setInterval(() => tick((n) => n + 1), 1000); return () => window.clearInterval(t); }, []);

  // Every attempt still running, across all conversations.
  const working = hub.chats.flatMap((chat) => chat.turns.map((turn) => {
    const last = turn.attempts[turn.attempts.length - 1];
    const task = last && tasks.find((t) => t.task_id === last.taskId);
    if (!last || !task || finished.includes(task.status) || turn.error) return null;
    return { chat, turn, last, task };
  })).filter(Boolean) as Array<{ chat: Hub["chats"][number]; turn: Hub["chats"][number]["turns"][number]; last: Hub["chats"][number]["turns"][number]["attempts"][number]; task: TaskSnapshot }>;
  const subagents = [...hub.streams.subagents.values()];

  return <aside className="flex h-screen w-[300px] shrink-0 flex-col gap-6 overflow-y-auto border-l border-line/70 bg-sidebar px-4 py-4">
    <section>
      <div className="mb-3 flex items-center justify-between"><h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">Trabalhando agora</h2>{working.length > 0 && <span className="rounded-full bg-raised px-2 py-0.5 text-[10px] text-zinc-300">{working.length}</span>}</div>
      {working.length === 0 && <p className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-[12px] text-muted">Nenhuma IA trabalhando.</p>}
      <div className="space-y-2">
        {working.map(({ chat, turn, last, task }) => {
          const b = brand[last.provider];
          const subs = subagents.filter((s) => s.taskId === last.taskId);
          return <button key={last.taskId} onClick={() => hub.setActiveId(chat.id)} className="w-full rounded-xl border p-3 text-left transition hover:brightness-125" style={{ borderColor: b.color + "40", background: b.soft }}>
            <div className="flex items-center gap-2"><ProviderMark provider={last.provider} size={14} /><span className="text-[12px] font-semibold" style={{ color: b.color }}>{b.name}</span><span className="ml-auto text-[10px] text-muted">{elapsed(turn.at)}</span></div>
            <p className="mt-1 truncate text-[12px] text-zinc-300">{chat.title}</p>
            <div className="mt-2 flex flex-wrap gap-1 text-[10px]">
              <span className="rounded bg-black/30 px-1.5 py-0.5 text-zinc-300">{last.modelName ?? "…"}</span>
              {turn.route && <span className="rounded bg-black/30 px-1.5 py-0.5 text-zinc-400">esforço {effortName[turn.route.effort] ?? turn.route.effort}</span>}
              {task.status === "awaiting_approval" && <span className="rounded bg-violet-500/20 px-1.5 py-0.5 text-violet-200">aguardando permissão</span>}
            </div>
            {subs.length > 0 && <div className="mt-2.5 space-y-1 border-t border-white/5 pt-2">
              <p className="text-[10px] uppercase tracking-wider text-muted">Subagentes</p>
              {subs.map((s) => <p key={s.id} className="flex items-center gap-1.5 text-[11px] text-zinc-300">{s.done ? <Check size={11} className="text-emerald-400" /> : <Loader2 size={11} className="animate-spin text-zinc-400" />}<span className="truncate">{s.description}</span><span className="ml-auto shrink-0 text-[10px] text-muted">{s.kind}</span></p>)}
            </div>}
          </button>;
        })}
      </div>
    </section>

    <section>
      <div className="mb-3 flex items-center justify-between"><h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">Uso das IAs</h2><button disabled={loading} onClick={async () => { setLoading(true); await hub.refreshQuotas(); setLoading(false); }} className="rounded-md p-1 text-muted transition hover:bg-raised hover:text-zinc-200" title="Atualizar"><RefreshCw size={12} className={loading ? "animate-spin" : ""} /></button></div>
      <div className="space-y-4">
        {order.map((id) => {
          const b = brand[id];
          const q = hub.quotas.find((x) => x.provider === id);
          return <div key={id}>
            <div className="mb-1.5 flex items-center gap-2"><ProviderMark provider={id} size={13} /><span className="text-[12px] font-medium" style={{ color: b.color }}>{b.name}</span>
              <span className={`ml-auto text-[10px] ${!q ? "text-muted" : q.error ? "text-muted" : q.available ? "text-emerald-400" : "text-rose-400"}`}>{!q ? "…" : q.error ? "indisponível" : q.available ? "disponível" : "sem cota"}</span></div>
            {q?.error && <p className="text-[10px] text-muted">{q.error}</p>}
            <div className="space-y-2">{q?.windows.map((w) => <div key={w.label}>
              <div className="mb-1 flex justify-between text-[10px]"><span className="text-zinc-400">{w.label}</span><span className="tabular-nums text-zinc-300">{Math.round(w.remaining_pct)}%</span></div>
              <div className="h-1.5 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full transition-all" style={{ width: `${Math.max(2, Math.min(100, w.remaining_pct))}%`, background: bar(w.remaining_pct) }} /></div>
              {w.resets && <p className="mt-0.5 text-[10px] text-muted">renova {when(w.resets)}</p>}
            </div>)}</div>
          </div>;
        })}
      </div>
      {hub.quotasAt > 0 && <p className="mt-4 text-[10px] text-muted">Atualizado às {new Date(hub.quotasAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</p>}
    </section>
  </aside>;
}
