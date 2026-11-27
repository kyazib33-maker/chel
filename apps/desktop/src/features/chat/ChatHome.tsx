import { useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, Send, Sparkles, Square } from "lucide-react";
import { cancelTask, desktopBridgeAvailable, launchAgent, recommendAgentRoute, type ProviderId, type RouteRecommendation, type TaskEvent, type TaskSnapshot } from "../../lib/tauri";

type Quality = "economy" | "balanced" | "maximum";
type Turn = { id: string; prompt: string; route: RouteRecommendation | null; taskId: string | null; error: string | null };

const names: Record<ProviderId, string> = { claude_code: "Claude", codex: "Codex", antigravity: "Antigravity" };
const effortName: Record<string, string> = { low: "rápido", medium: "normal", high: "caprichado", xhigh: "máximo", max: "máximo" };
const qualityLabel: Record<Quality, string> = { economy: "Econômico", balanced: "Equilibrado", maximum: "Caprichado" };
const finished = ["succeeded", "failed", "cancelled", "quota_exceeded"];

function load(key: string, fallback: string) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
function save(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* ignore */ } }

/** Pull the human-readable reply out of one line of CLI output (Claude stream-json, Codex --json, or plain text). */
function readableText(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const data = JSON.parse(trimmed);
    if (data.type === "assistant" && Array.isArray(data.message?.content)) {
      const text = data.message.content.filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");
      return text || null;
    }
    if (data.type === "item.completed" && data.item?.type === "agent_message") return data.item.text ?? null;
    if (data.msg?.type === "agent_message") return data.msg.message ?? null;
    return null;
  } catch { return null; }
}

export default function ChatHome({ tasks, events }: { tasks: TaskSnapshot[]; events: TaskEvent[] }) {
  const [folder, setFolder] = useState(() => load("psylium.folder", ""));
  const [quality, setQuality] = useState<Quality>(() => load("psylium.quality", "balanced") as Quality);
  const [text, setText] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => save("psylium.folder", folder), [folder]);
  useEffect(() => save("psylium.quality", quality), [quality]);

  const replies = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const event of events) {
      if (event.payload.type !== "output" || event.payload.data.stream !== "stdout") continue;
      const piece = readableText(event.payload.data.line);
      if (piece) map.set(event.task_id, [...(map.get(event.task_id) ?? []), piece]);
    }
    return map;
  }, [events]);

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [turns.length, events.length]);

  async function send() {
    const prompt = text.trim();
    if (!prompt || !folder.trim() || busy) return;
    const id = crypto.randomUUID();
    setTurns((t) => [...t, { id, prompt, route: null, taskId: null, error: null }]);
    setText(""); setBusy(true);
    const update = (patch: Partial<Turn>) => setTurns((t) => t.map((turn) => turn.id === id ? { ...turn, ...patch } : turn));
    try {
      const route = await recommendAgentRoute({ prompt, quality, preferred_provider: null, allow_antigravity: true });
      update({ route });
      const taskId = await launchAgent({ provider: route.provider, prompt, cwd: folder.trim(), model: route.model, effort: route.effort, display_name: `${names[route.provider]} · chat` });
      update({ taskId });
    } catch (reason) { update({ error: String(reason) }); }
    finally { setBusy(false); }
  }

  const ready = desktopBridgeAvailable && folder.trim() !== "";

  return <div className="mx-auto flex h-[calc(100vh-3rem)] max-w-3xl flex-col">
    <div className="flex flex-wrap items-center gap-2 pb-3 text-xs">
      <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2"><FolderOpen size={14} className="shrink-0 text-muted" /><input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="Pasta do projeto (ex.: C:\Projetos\meu-app)" className="min-w-0 flex-1 bg-transparent outline-none" /></label>
      <div className="flex rounded-lg border border-line bg-panel p-0.5" title="Econômico gasta menos; Caprichado gasta mais e capricha mais">
        {(Object.keys(qualityLabel) as Quality[]).map((q) => <button key={q} onClick={() => setQuality(q)} className={`rounded-md px-3 py-1.5 ${quality === q ? "bg-slate-700 text-white" : "text-slate-400 hover:text-white"}`}>{qualityLabel[q]}</button>)}
      </div>
    </div>

    <div className="flex-1 space-y-5 overflow-y-auto py-4">
      {turns.length === 0 && <div className="mt-24 text-center"><Sparkles className="mx-auto text-accent" /><h2 className="mt-3 text-xl font-semibold">O que você quer fazer?</h2><p className="mt-2 text-sm text-muted">Escreva normalmente. O Psylium escolhe a IA e o modelo certos para gastar pouco e entregar bem.</p>{!folder.trim() && <p className="mt-4 text-xs text-amber-300">Primeiro, escolha a pasta do projeto ali em cima.</p>}</div>}
      {turns.map((turn) => {
        const task = tasks.find((t) => t.task_id === turn.taskId);
        const reply = turn.taskId ? (replies.get(turn.taskId) ?? []).join("\n\n") : "";
        const running = turn.taskId && (!task || !finished.includes(task.status));
        return <div key={turn.id} className="space-y-3">
          <div className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-slate-700 px-4 py-2.5 text-sm">{turn.prompt}</div>
          <div className="max-w-[95%] rounded-2xl rounded-bl-sm border border-line bg-panel px-4 py-3 text-sm">
            {turn.route && <p className="mb-2 text-[11px] text-muted" title={turn.route.rationale.join("\n")}>{names[turn.route.provider]}{turn.route.model ? ` · ${turn.route.model}` : ""} · modo {effortName[turn.route.effort] ?? turn.route.effort}</p>}
            {turn.error ? <p className="text-rose-300">Não deu certo: {turn.error}</p>
              : reply ? <p className="whitespace-pre-wrap leading-relaxed">{reply}</p>
              : <p className="text-muted">{turn.route ? "Trabalhando…" : "Escolhendo a melhor IA…"}</p>}
            {task?.status === "awaiting_approval" && <p className="mt-2 text-xs text-violet-300">A IA está pedindo permissão — veja em "Pedidos de permissão".</p>}
            {task?.status === "failed" && !reply && <p className="mt-2 text-xs text-rose-300">A IA terminou com erro{task.last_error ? `: ${task.last_error}` : "."}</p>}
            {task?.status === "quota_exceeded" && <p className="mt-2 text-xs text-amber-300">O limite de uso dessa IA acabou. Tente de novo mais tarde.</p>}
            {running && turn.taskId && <button onClick={() => void cancelTask(turn.taskId!)} className="mt-2 flex items-center gap-1 text-[11px] text-slate-400 hover:text-white"><Square size={10} />Parar</button>}
          </div>
        </div>;
      })}
      <div ref={bottom} />
    </div>

    <div className="flex items-end gap-2 rounded-2xl border border-line bg-panel p-2">
      <textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} rows={2} placeholder={ready ? "Escreva sua mensagem…  (Enter envia, Shift+Enter quebra linha)" : desktopBridgeAvailable ? "Escolha a pasta do projeto primeiro" : "Abra pelo app instalado para conversar"} className="max-h-48 min-h-[44px] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none" />
      <button disabled={!ready || busy || !text.trim()} onClick={() => void send()} className="rounded-xl bg-accent p-3 text-zinc-950 disabled:opacity-40" title="Enviar"><Send size={16} /></button>
    </div>
  </div>;
}
