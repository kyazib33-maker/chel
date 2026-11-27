import { useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, Send, Sparkles, Square } from "lucide-react";
import { cancelTask, desktopBridgeAvailable, launchAgent, recommendAgentRoute, type ProviderId, type RouteRecommendation, type TaskEvent, type TaskSnapshot } from "../../lib/tauri";

type Quality = "economy" | "balanced" | "maximum";
type Attempt = { provider: ProviderId; taskId: string };
type Turn = { id: string; prompt: string; route: RouteRecommendation | null; attempts: Attempt[]; error: string | null; notes: string[] };

const names: Record<ProviderId, string> = { claude_code: "Claude", codex: "Codex", antigravity: "Antigravity" };
const effortName: Record<string, string> = { low: "rápido", medium: "normal", high: "caprichado", xhigh: "máximo", max: "máximo" };
const qualityLabel: Record<Quality, string> = { economy: "Econômico", balanced: "Equilibrado", maximum: "Caprichado" };
const finished = ["succeeded", "failed", "cancelled", "quota_exceeded"];
const validEffort: Record<ProviderId, string[]> = { claude_code: ["low", "medium", "high", "max"], codex: ["low", "medium", "high", "xhigh"], antigravity: ["low", "medium", "high", "xhigh", "max"] };

function load(key: string, fallback: string) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
function save(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* ignore */ } }

/** Pull the human-readable reply out of one line of CLI output (Claude stream-json, Codex --json, or plain text). */
/** Find a human-readable failure reason in CLI output, e.g. a quota message. */
function failureText(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.startsWith("{")) {
    try { const data = JSON.parse(trimmed); return data.event === "result" && data.result?.error ? data.result.error : data.type === "result" && data.is_error ? (data.result ?? null) : null; } catch { return null; }
  }
  return /quota|limit|rate|unauthori|login|not logged/i.test(trimmed) && !trimmed.startsWith("AGY_ERROR") ? trimmed.replace(/^error:\s*/i, "") : null;
}

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
    if (data.event === "result" && data.result?.response) return data.result.response;
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

  const { replies, failures } = useMemo(() => {
    const replies = new Map<string, string[]>();
    const failures = new Map<string, string>();
    for (const event of events) {
      if (event.payload.type !== "output") continue;
      const line = event.payload.data.line;
      const why = failureText(line);
      if (why) { failures.set(event.task_id, why); continue; }
      if (event.payload.data.stream !== "stdout") continue;
      const piece = readableText(line);
      if (piece) replies.set(event.task_id, [...(replies.get(event.task_id) ?? []), piece]);
    }
    return { replies, failures };
  }, [events]);

  // When an AI fails before answering (quota, login, crash), hand the message to the next AI in line.
  useEffect(() => {
    for (const turn of turns) {
      const last = turn.attempts[turn.attempts.length - 1];
      if (!last || !turn.route || turn.error) continue;
      const task = tasks.find((t) => t.task_id === last.taskId);
      if (!task || !["failed", "quota_exceeded"].includes(task.status) || replies.get(last.taskId)?.length) continue;
      const tried = turn.attempts.map((a) => a.provider);
      const next = turn.route.fallback_order.find((p) => !tried.includes(p));
      const why = failures.get(last.taskId) ?? task.last_error ?? "erro desconhecido";
      if (!next) { patchTurn(turn.id, { error: `Nenhuma IA conseguiu responder. Último motivo: ${why}` }); continue; }
      const note = `${names[last.provider]} não conseguiu (${why}). Tentando com ${names[next]}…`;
      const effort = validEffort[next].includes(turn.route.effort) ? turn.route.effort : "medium";
      patchTurn(turn.id, { attempts: [...turn.attempts, { provider: next, taskId: "pending" }], notes: [...turn.notes, note] });
      void launchAgent({ provider: next, prompt: turn.prompt, cwd: folder.trim(), model: null, effort, display_name: `${names[next]} · chat` })
        .then((taskId) => setTurns((all) => all.map((t) => t.id === turn.id ? { ...t, attempts: t.attempts.map((a) => a.taskId === "pending" ? { ...a, taskId } : a) } : t)))
        .catch((reason) => patchTurn(turn.id, { error: String(reason) }));
    }
  }, [tasks, turns, replies, failures]);

  function patchTurn(id: string, patch: Partial<Turn>) { setTurns((all) => all.map((t) => t.id === id ? { ...t, ...patch } : t)); }

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [turns.length, events.length]);

  async function send() {
    const prompt = text.trim();
    if (!prompt || !folder.trim() || busy) return;
    const id = crypto.randomUUID();
    setTurns((t) => [...t, { id, prompt, route: null, attempts: [], error: null, notes: [] }]);
    setText(""); setBusy(true);
    const update = (patch: Partial<Turn>) => patchTurn(id, patch);
    try {
      const route = await recommendAgentRoute({ prompt, quality, preferred_provider: null, allow_antigravity: true });
      update({ route });
      const taskId = await launchAgent({ provider: route.provider, prompt, cwd: folder.trim(), model: route.model, effort: route.effort, display_name: `${names[route.provider]} · chat` });
      update({ attempts: [{ provider: route.provider, taskId }] });
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
        const last = turn.attempts[turn.attempts.length - 1];
        const taskId = last && last.taskId !== "pending" ? last.taskId : null;
        const task = tasks.find((t) => t.task_id === taskId);
        const reply = taskId ? (replies.get(taskId) ?? []).join("\n\n") : "";
        const running = !turn.error && taskId && (!task || !finished.includes(task.status));
        const provider = last?.provider ?? turn.route?.provider;
        return <div key={turn.id} className="space-y-3">
          <div className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-slate-700 px-4 py-2.5 text-sm">{turn.prompt}</div>
          <div className="max-w-[95%] rounded-2xl rounded-bl-sm border border-line bg-panel px-4 py-3 text-sm">
            {turn.notes.map((note, i) => <p key={i} className="mb-1 text-[11px] text-amber-300">{note}</p>)}
            {turn.route && provider && <p className="mb-2 text-[11px] text-muted" title={turn.route.rationale.join("\n")}>{names[provider]}{provider === turn.route.provider && turn.route.model ? ` · ${turn.route.model}` : ""} · modo {effortName[turn.route.effort] ?? turn.route.effort}</p>}
            {turn.error ? <p className="text-rose-300">Não deu certo: {turn.error}</p>
              : reply ? <p className="whitespace-pre-wrap leading-relaxed">{reply}</p>
              : task && finished.includes(task.status) ? <p className="text-muted">A IA terminou sem enviar resposta em texto.</p>
              : <p className="text-muted">{turn.route ? "Trabalhando…" : "Escolhendo a melhor IA…"}</p>}
            {task?.status === "awaiting_approval" && <p className="mt-2 text-xs text-violet-300">A IA está pedindo permissão — veja em "Pedidos de permissão".</p>}
                                    {running && taskId && <button onClick={() => void cancelTask(taskId)} className="mt-2 flex items-center gap-1 text-[11px] text-slate-400 hover:text-white"><Square size={10} />Parar</button>}
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
