import { useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, Plus, Send, Sparkles, Square } from "lucide-react";
import { brand, effortName, ProviderMark } from "../../lib/providers";
import { cancelTask, defaultWorkspace, desktopBridgeAvailable, launchAgent, modelCatalog, readQuotas, type ModelCatalog, recommendAgentRoute, type ProviderQuota, type ProviderId, type RouteRecommendation, type TaskEvent, type TaskSnapshot } from "../../lib/tauri";

type Quality = "economy" | "balanced" | "maximum";
type Attempt = { provider: ProviderId; taskId: string; sessionId?: string; model?: string | null; modelName?: string };
type Turn = { id: string; prompt: string; route: RouteRecommendation | null; attempts: Attempt[]; error: string | null; notes: string[]; at: number; answer?: string; cwd?: string };

const names: Record<ProviderId, string> = { claude_code: "Claude", codex: "Codex", antigravity: "Antigravity" };
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

/** The CLI's own conversation id, used to continue the same conversation next time. */
function sessionIdOf(line: string): string | null {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  try {
    const d = JSON.parse(t);
    if (d.type === "system" && d.subtype === "init" && d.session_id) return d.session_id;
    if (d.type === "thread.started" && d.thread_id) return d.thread_id;
    if (d.event === "init" && d.conversation_id) return d.conversation_id;
    return null;
  } catch { return null; }
}

/** "claude-sonnet-5-5" → "Sonnet 5.5", "claude-opus-4-6-thinking" → "Opus 4.6". */
export function prettyModel(id: string): string {
  const m = id.match(/^claude-([a-z]+)-(\d+)-(\d+)/);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`;
  if (/^(fable|opus|sonnet|haiku)$/.test(id)) return id[0].toUpperCase() + id.slice(1);
  return id;
}

/** The model the CLI says it is running (Claude reports it in its first event). */
function modelOf(line: string): string | null {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  try { const d = JSON.parse(t); return d.type === "system" && d.subtype === "init" && typeof d.model === "string" ? d.model : null; } catch { return null; }
}

/** Picks an explicit model so the chat can always show which one is in use. */
function chooseModel(provider: ProviderId, quality: Quality, effort: string, catalog: ModelCatalog | null, quotas: ProviderQuota[]): { id: string | null; name: string } {
  if (provider === "claude_code") {
    const alias = quality === "maximum" ? "opus" : quality === "economy" && effort === "low" ? "haiku" : "sonnet";
    return { id: alias, name: prettyModel(alias) };
  }
  if (provider === "codex") {
    const id = catalog?.codex_default ?? catalog?.codex[0]?.id ?? null;
    return { id, name: catalog?.codex.find((m) => m.id === id)?.name ?? id ?? "Codex" };
  }
  const list = catalog?.antigravity ?? [];
  const windows = quotas.find((q) => q.provider === "antigravity")?.windows ?? [];
  const room = (family: string) => { const w = windows.filter((x) => x.label.startsWith(family)); return w.length === 0 || w.every((x) => x.remaining_pct > 0); };
  const level = effort === "max" ? "xhigh" : effort;
  let candidates: string[];
  if (room("Gemini")) candidates = quality === "economy" ? [`gemini-3.8-flash-${level}`, `gemini-4-hydrogen-${level}`] : [`gemini-4-hydrogen-${level}`, `gemini-3.8-flash-${level}`];
  else candidates = quality === "maximum" || effort === "high" || effort === "xhigh" || effort === "max" ? ["claude-opus-4-6-thinking", "claude-sonnet-4-6"] : ["claude-sonnet-4-6", "claude-opus-4-6-thinking"];
  const found = candidates.map((c) => list.find((m) => m.id === c)).find(Boolean) ?? list[0];
  return found ? { id: found.id, name: found.name.replace(/\s*\((Thinking|Low|Medium|High|XHigh)\)$/i, "") } : { id: null, name: "Antigravity" };
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
  const [turns, setTurns] = useState<Turn[]>(() => { try { return JSON.parse(load("psylium.chat", "[]")) as Turn[]; } catch { return []; } });
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const quotaCache = useRef<{ at: number; list: ProviderQuota[] } | null>(null);
  const catalog = useRef<ModelCatalog | null>(null);
  useEffect(() => { if (desktopBridgeAvailable) void modelCatalog().then((c) => { catalog.current = c; }).catch(() => undefined); }, []);

  /** Which AIs still have usage left (cached for 2 minutes; unknown counts as available). */
  async function availability(): Promise<(p: ProviderId) => boolean> {
    if (!quotaCache.current || Date.now() - quotaCache.current.at > 120_000) {
      try { quotaCache.current = { at: Date.now(), list: await readQuotas() }; } catch { quotaCache.current = { at: Date.now(), list: [] }; }
    }
    const list = quotaCache.current.list;
    return (p) => { const q = list.find((x) => x.provider === p); return !q || q.error !== null || q.available; };
  }

  useEffect(() => save("psylium.folder", folder), [folder]);
  const [fallbackDir, setFallbackDir] = useState("");
  useEffect(() => { if (desktopBridgeAvailable) void defaultWorkspace().then(setFallbackDir).catch(() => undefined); }, []);
  const workDir = folder.trim() || fallbackDir;
  useEffect(() => save("psylium.quality", quality), [quality]);
  useEffect(() => save("psylium.chat", JSON.stringify(turns.slice(-200))), [turns]);

  const { replies, failures, sessions, models } = useMemo(() => {
    const replies = new Map<string, string[]>();
    const failures = new Map<string, string>();
    const sessions = new Map<string, string>();
    const models = new Map<string, string>();
    for (const event of events) {
      if (event.payload.type !== "output") continue;
      const line = event.payload.data.line;
      const reported = modelOf(line);
      if (reported) models.set(event.task_id, reported);
      const sid = sessionIdOf(line);
      if (sid) { sessions.set(event.task_id, sid); continue; }
      const why = failureText(line);
      if (why) { failures.set(event.task_id, why); continue; }
      if (event.payload.data.stream !== "stdout") continue;
      const piece = readableText(line);
      if (piece) replies.set(event.task_id, [...(replies.get(event.task_id) ?? []), piece]);
    }
    return { replies, failures, sessions, models };
  }, [events]);

  // When an AI fails before answering (quota, login, crash), hand the message to the next AI in line.
  useEffect(() => {
    for (const turn of turns) {
      const last = turn.attempts[turn.attempts.length - 1];
      if (!last || !turn.route || turn.error) continue;
      const task = tasks.find((t) => t.task_id === last.taskId);
      if (!task || !["failed", "quota_exceeded"].includes(task.status) || replies.get(last.taskId)?.length) continue;
      const tried = turn.attempts.map((a) => a.provider);
      const has = quotaCache.current?.list ?? [];
      const next = turn.route.fallback_order.find((p) => !tried.includes(p) && !has.some((q) => q.provider === p && q.error === null && !q.available));
      const why = failures.get(last.taskId) ?? task.last_error ?? "erro desconhecido";
      if (!next) { patchTurn(turn.id, { error: `Nenhuma IA conseguiu responder. Último motivo: ${why}` }); continue; }
      const note = `${names[last.provider]} não conseguiu (${why}). Tentando com ${names[next]}…`;
      const effort = validEffort[next].includes(turn.route.effort) ? turn.route.effort : "medium";
      const chosen = chooseModel(next, quality, effort, catalog.current, quotaCache.current?.list ?? []);
      patchTurn(turn.id, { attempts: [...turn.attempts, { provider: next, taskId: "pending", model: chosen.id, modelName: chosen.name }], notes: [...turn.notes, note] });
      void launchAgent({ provider: next, prompt: turn.prompt, cwd: turn.cwd || workDir, model: chosen.id, effort, display_name: `${names[next]} · chat` })
        .then((taskId) => setTurns((all) => all.map((t) => t.id === turn.id ? { ...t, attempts: t.attempts.map((a) => a.taskId === "pending" ? { ...a, taskId } : a) } : t)))
        .catch((reason) => patchTurn(turn.id, { error: String(reason) }));
    }
  }, [tasks, turns, replies, failures]);

  // Keep each answer inside the conversation so it survives leaving the page or closing the app.
  useEffect(() => {
    const changed = turns.some((turn) => {
      const last = turn.attempts[turn.attempts.length - 1];
      const live = last ? (replies.get(last.taskId) ?? []).join("\n\n") : "";
      const sid = last ? sessions.get(last.taskId) : undefined;
      const real = last ? models.get(last.taskId) : undefined;
      return (live && live !== turn.answer) || (sid && sid !== last?.sessionId) || (real && prettyModel(real) !== last?.modelName);
    });
    if (!changed) return;
    setTurns((all) => all.map((turn) => {
      const last = turn.attempts[turn.attempts.length - 1];
      const live = last ? (replies.get(last.taskId) ?? []).join("\n\n") : "";
      const sid = last ? sessions.get(last.taskId) : undefined;
      let next = turn;
      if (live && live !== turn.answer) next = { ...next, answer: live };
      if (sid && last && sid !== last.sessionId) next = { ...next, attempts: next.attempts.map((a) => a === last ? { ...a, sessionId: sid } : a) };
      const real = last ? models.get(last.taskId) : undefined;
      const nextLast = next.attempts[next.attempts.length - 1];
      if (real && nextLast && prettyModel(real) !== nextLast.modelName) next = { ...next, attempts: next.attempts.map((a, i) => i === next.attempts.length - 1 ? { ...a, modelName: prettyModel(real) } : a) };
      return next;
    }));
  }, [replies, sessions, models, turns]);

  function patchTurn(id: string, patch: Partial<Turn>) { setTurns((all) => all.map((t) => t.id === id ? { ...t, ...patch } : t)); }

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [turns.length, events.length]);

  async function send() {
    const prompt = text.trim();
    if (!prompt || !workDir || busy) return;
    const id = crypto.randomUUID();
    setTurns((t) => [...t, { id, prompt, route: null, attempts: [], error: null, notes: [], at: Date.now(), cwd: workDir }]);
    setText(""); setBusy(true);
    const update = (patch: Partial<Turn>) => patchTurn(id, patch);
    try {
      const ok = await availability();
      if (!catalog.current) catalog.current = await modelCatalog().catch(() => null);
      const route = await recommendAgentRoute({ prompt, quality, preferred_provider: null, allow_antigravity: true });
      // Continue the conversation with the AI that answered last, if it still has quota.
      // Only continue a conversation started in this same folder (the AIs store conversations per folder).
      const previous = [...turns].reverse().filter((t) => (t.cwd ?? workDir) === workDir).map((t) => t.attempts[t.attempts.length - 1]).find((a) => a?.sessionId);
      let provider: ProviderId;
      let resumeId: string | null = null;
      const notes: string[] = [];
      if (previous && ok(previous.provider)) {
        provider = previous.provider; resumeId = previous.sessionId ?? null;
      } else {
        const order = [route.provider, ...route.fallback_order.filter((p) => p !== route.provider)];
        const pick = order.find(ok);
        if (!pick) { update({ route, error: "Todas as IAs estão sem cota agora. Veja no Painel quando cada uma volta." }); return; }
        if (pick !== route.provider) notes.push(`${names[route.provider]} está sem cota; usando ${names[pick]}.`);
        if (previous && previous.provider !== pick) notes.push(`${names[previous.provider]} está sem cota; a conversa continua com ${names[pick]}, sem o histórico anterior.`);
        provider = pick;
      }
      const effort = validEffort[provider].includes(route.effort) ? route.effort : "medium";
      const chosen = chooseModel(provider, quality, effort, catalog.current, quotaCache.current?.list ?? []);
      update({ route: { ...route, provider, model: chosen.id, effort }, notes });
      const taskId = await launchAgent({ provider, prompt, cwd: workDir, model: chosen.id, effort, display_name: `${names[provider]} · chat`, resume_id: resumeId });
      update({ attempts: [{ provider, taskId, model: chosen.id, modelName: chosen.name }] });
    } catch (reason) { update({ error: String(reason) }); }
    finally { setBusy(false); }
  }

  const ready = desktopBridgeAvailable && workDir !== "";

  return <div className="mx-auto flex h-[calc(100vh-3rem)] max-w-3xl flex-col">
    <div className="flex flex-wrap items-center gap-2 pb-3 text-xs">
      <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2"><FolderOpen size={14} className="shrink-0 text-muted" /><input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={fallbackDir ? `Pasta (opcional) — sem escolher, uso ${fallbackDir}` : "Pasta do projeto (opcional)"} className="min-w-0 flex-1 bg-transparent outline-none" /></label>
      {turns.length > 0 && <button onClick={() => setTurns([])} className="flex items-center gap-1.5 rounded-lg border border-line bg-panel px-3 py-2 text-slate-300 hover:text-white" title="Começar uma conversa nova"><Plus size={13} />Nova conversa</button>}
      <div className="flex rounded-lg border border-line bg-panel p-0.5" title="Econômico gasta menos; Caprichado gasta mais e capricha mais">
        {(Object.keys(qualityLabel) as Quality[]).map((q) => <button key={q} onClick={() => setQuality(q)} className={`rounded-md px-3 py-1.5 ${quality === q ? "bg-slate-700 text-white" : "text-slate-400 hover:text-white"}`}>{qualityLabel[q]}</button>)}
      </div>
    </div>

    <div className="flex-1 space-y-5 overflow-y-auto py-4">
      {turns.length === 0 && <div className="mt-24 text-center"><Sparkles className="mx-auto text-accent" /><h2 className="mt-3 text-xl font-semibold">O que você quer fazer?</h2><p className="mt-2 text-sm text-muted">Escreva normalmente. O Psylium escolhe a IA e o modelo certos para gastar pouco e entregar bem.</p><p className="mt-4 text-xs text-muted">Quer que a IA mexa num projeto seu? Escolha a pasta ali em cima. Se não escolher, ela trabalha na pasta Psylium dos seus Documentos.</p></div>}
      {turns.map((turn) => {
        const last = turn.attempts[turn.attempts.length - 1];
        const taskId = last && last.taskId !== "pending" ? last.taskId : null;
        const task = tasks.find((t) => t.task_id === taskId);
        const reply = (taskId ? (replies.get(taskId) ?? []).join("\n\n") : "") || turn.answer || "";
        const running = !turn.error && taskId && (task ? !finished.includes(task.status) : !turn.answer);
        const stale = !task && !reply && !turn.error && Date.now() - (turn.at ?? 0) > 120_000;
        const provider = last?.provider ?? turn.route?.provider;
        const b = provider ? brand[provider] : null;
        const model = last?.modelName ?? (turn.route?.model ? prettyModel(turn.route.model) : "…");
        const effort = turn.route ? (effortName[turn.route.effort] ?? turn.route.effort) : "";
        return <div key={turn.id} className="space-y-3">
          <div className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-slate-700 px-4 py-2.5 text-sm">{turn.prompt}</div>
          <div className="max-w-[95%] rounded-2xl rounded-bl-sm border px-4 py-3 text-sm" style={{ borderColor: b ? b.color + "66" : undefined, background: b ? b.soft : undefined }}>
            {turn.notes.map((note, i) => <p key={i} className="mb-1 text-[11px] text-amber-300">{note}</p>)}
            {turn.route && provider && b && <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]" title={turn.route.rationale.join("\n")}><ProviderMark provider={provider} size={16} /><span className="font-semibold" style={{ color: b.color }}>{b.name}</span><span className="rounded-full border border-line px-2 py-0.5 text-slate-300">{model}</span><span className="rounded-full border border-line px-2 py-0.5 text-slate-300">esforço {effort}</span></div>}
            {turn.error ? <p className="text-rose-300">Não deu certo: {turn.error}</p>
              : reply ? <p className="whitespace-pre-wrap leading-relaxed">{reply}</p>
              : (task && finished.includes(task.status)) || stale ? <p className="text-muted">A IA terminou sem enviar resposta em texto.</p>
              : <p className="text-muted">{turn.route ? "Trabalhando…" : "Escolhendo a melhor IA…"}</p>}
            {task?.status === "awaiting_approval" && <p className="mt-2 text-xs text-violet-300">A IA está pedindo permissão — veja em "Pedidos de permissão".</p>}
                                    {running && !stale && taskId && <button onClick={() => void cancelTask(taskId)} className="mt-2 flex items-center gap-1 text-[11px] text-slate-400 hover:text-white"><Square size={10} />Parar</button>}
          </div>
        </div>;
      })}
      <div ref={bottom} />
    </div>

    <div className="flex items-end gap-2 rounded-2xl border border-line bg-panel p-2">
      <textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} rows={2} placeholder={ready ? "Escreva sua mensagem…  (Enter envia, Shift+Enter quebra linha)" : desktopBridgeAvailable ? "Preparando…" : "Abra pelo app instalado para conversar"} className="max-h-48 min-h-[44px] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none" />
      <button disabled={!ready || busy || !text.trim()} onClick={() => void send()} className="rounded-xl bg-accent p-3 text-zinc-950 disabled:opacity-40" title="Enviar"><Send size={16} /></button>
    </div>
  </div>;
}
