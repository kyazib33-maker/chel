import { useEffect, useMemo, useRef, useState } from "react";
import { defaultWorkspace, desktopBridgeAvailable, launchAgent, modelCatalog, readQuotas, recommendAgentRoute, type ModelCatalog, type ProviderId, type ProviderQuota, type TaskEvent, type TaskSnapshot } from "../../lib/tauri";
import { chooseModel, names, newChat, prettyModel, readStreams, requestedProvider, titleFrom, validEffort, type Chat, type Quality, type Turn } from "./engine";

function load<T>(key: string, fallback: T): T { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) as T : fallback; } catch { return fallback; } }
function save(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ } }

function initialChats(): Chat[] {
  const chats = load<Chat[]>("psylium.chats", []);
  if (chats.length) return chats;
  // Bring over the single conversation from older versions.
  const old = load<Turn[]>("psylium.chat", []);
  const folder = (() => { try { return localStorage.getItem("psylium.folder") ?? ""; } catch { return ""; } })();
  const first = newChat(folder);
  if (old.length) { first.turns = old; first.title = titleFrom(old[0].prompt); }
  return [first];
}

/** Runs every conversation: sending, falling back to another AI, and saving answers — also for conversations not on screen. */
export function useChats(tasks: TaskSnapshot[], events: TaskEvent[]) {
  const [chats, setChats] = useState<Chat[]>(initialChats);
  const [activeId, setActiveId] = useState<string>(() => load<string>("psylium.activeChat", "") || chats[0]?.id);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [quotas, setQuotas] = useState<ProviderQuota[]>([]);
  const [quotasAt, setQuotasAt] = useState(0);
  const [fallbackDir, setFallbackDir] = useState("");
  const catalog = useRef<ModelCatalog | null>(null);
  const quotasRef = useRef<ProviderQuota[]>([]);
  quotasRef.current = quotas;

  useEffect(() => save("psylium.chats", chats.map((c) => ({ ...c, turns: c.turns.slice(-200) }))), [chats]);
  useEffect(() => save("psylium.activeChat", activeId), [activeId]);
  useEffect(() => {
    if (!desktopBridgeAvailable) return;
    void defaultWorkspace().then(setFallbackDir).catch(() => undefined);
    void modelCatalog().then((c) => { catalog.current = c; }).catch(() => undefined);
    void refreshQuotas();
    const timer = window.setInterval(() => void refreshQuotas(), 180_000);
    return () => window.clearInterval(timer);
  }, []);

  async function refreshQuotas() {
    if (!desktopBridgeAvailable) return;
    try { const q = await readQuotas(); setQuotas(q); quotasRef.current = q; setQuotasAt(Date.now()); } catch { /* keep last */ }
  }
  const hasQuota = (p: ProviderId) => { const q = quotasRef.current.find((x) => x.provider === p); return !q || q.error !== null || q.available; };

  const streams = useMemo(() => readStreams(events), [events]);
  const active = chats.find((c) => c.id === activeId) ?? chats[0];

  function patchChat(chatId: string, fn: (c: Chat) => Chat) { setChats((all) => all.map((c) => c.id === chatId ? fn(c) : c)); }
  function patchTurn(chatId: string, turnId: string, patch: Partial<Turn> | ((t: Turn) => Turn)) {
    patchChat(chatId, (c) => ({ ...c, updatedAt: Date.now(), turns: c.turns.map((t) => t.id !== turnId ? t : typeof patch === "function" ? patch(t) : { ...t, ...patch }) }));
  }

  // Save answers, conversation ids and real model names into the conversations.
  useEffect(() => {
    const { replies, sessions, models } = streams;
    const update = (t: Turn): Turn => {
      const last = t.attempts[t.attempts.length - 1];
      if (!last) return t;
      const live = (replies.get(last.taskId) ?? []).join("\n\n");
      const sid = sessions.get(last.taskId);
      const real = models.get(last.taskId);
      let next = t;
      if (live && live !== t.answer) next = { ...next, answer: live };
      if ((sid && sid !== last.sessionId) || (real && prettyModel(real) !== last.modelName)) {
        next = { ...next, attempts: next.attempts.map((a, i) => i !== next.attempts.length - 1 ? a : { ...a, sessionId: sid ?? a.sessionId, modelName: real ? prettyModel(real) : a.modelName }) };
      }
      return next;
    };
    if (!chats.some((c) => c.turns.some((t) => update(t) !== t))) return;
    setChats((all) => all.map((c) => { const turns = c.turns.map(update); return turns.some((t, i) => t !== c.turns[i]) ? { ...c, turns } : c; }));
  }, [streams, chats]);

  // When an AI fails before answering, hand the message to the next AI that still has quota.
  useEffect(() => {
    for (const chat of chats) for (const turn of chat.turns) {
      const last = turn.attempts[turn.attempts.length - 1];
      if (!last || !turn.route || turn.error) continue;
      const task = tasks.find((t) => t.task_id === last.taskId);
      if (!task || !["failed", "quota_exceeded"].includes(task.status) || streams.replies.get(last.taskId)?.length) continue;
      const tried = turn.attempts.map((a) => a.provider);
      const next = turn.route.fallback_order.find((p) => !tried.includes(p) && hasQuota(p));
      const why = streams.failures.get(last.taskId) ?? task.last_error ?? "erro desconhecido";
      if (!next) { patchTurn(chat.id, turn.id, { error: `Nenhuma IA conseguiu responder. Último motivo: ${why}` }); continue; }
      const effort = validEffort[next].includes(turn.route.effort) ? turn.route.effort : "medium";
      const chosen = chooseModel(next, chat.quality, effort, catalog.current, quotasRef.current);
      patchTurn(chat.id, turn.id, (t) => ({ ...t, attempts: [...t.attempts, { provider: next, taskId: "pending", model: chosen.id, modelName: chosen.name }], notes: [...t.notes, `${names[last.provider]} não conseguiu (${why}). Tentando com ${names[next]}…`] }));
      void launchAgent({ provider: next, prompt: turn.prompt, cwd: turn.cwd || chat.folder || fallbackDir, model: chosen.id, effort, display_name: `${names[next]} · ${chat.title}` })
        .then((taskId) => patchTurn(chat.id, turn.id, (t) => ({ ...t, attempts: t.attempts.map((a) => a.taskId === "pending" ? { ...a, taskId } : a) })))
        .catch((reason) => patchTurn(chat.id, turn.id, { error: String(reason) }));
    }
  }, [tasks, chats, streams]);

  async function send(chatId: string, prompt: string, forced: ProviderId | "auto") {
    const chat = chats.find((c) => c.id === chatId);
    const workDir = chat?.folder.trim() || fallbackDir;
    if (!chat || !prompt.trim() || !workDir || busy[chatId]) return;
    const turnId = crypto.randomUUID();
    patchChat(chatId, (c) => ({ ...c, title: c.turns.length === 0 ? titleFrom(prompt) : c.title, updatedAt: Date.now(), turns: [...c.turns, { id: turnId, prompt, route: null, attempts: [], error: null, notes: [], at: Date.now(), cwd: workDir }] }));
    setBusy((b) => ({ ...b, [chatId]: true }));
    const update = (patch: Partial<Turn>) => patchTurn(chatId, turnId, patch);
    try {
      if (!quotasRef.current.length) await refreshQuotas();
      if (!catalog.current) catalog.current = await modelCatalog().catch(() => null);
      const route = await recommendAgentRoute({ prompt, quality: chat.quality, preferred_provider: null, allow_antigravity: true });
      const sameFolder = chat.turns.filter((t) => (t.cwd ?? workDir) === workDir);
      const lastOf = (p?: ProviderId) => [...sameFolder].reverse().map((t) => t.attempts[t.attempts.length - 1]).find((a) => a?.sessionId && (!p || a.provider === p));
      const wanted = forced !== "auto" ? forced : requestedProvider(prompt);
      const notes: string[] = [];
      let provider: ProviderId;
      if (wanted) {
        provider = wanted;
        if (!hasQuota(wanted)) notes.push(`${names[wanted]} parece estar sem cota agora; tentando mesmo assim.`);
      } else {
        const previous = lastOf();
        if (previous && hasQuota(previous.provider)) provider = previous.provider;
        else {
          const order = [route.provider, ...route.fallback_order.filter((p) => p !== route.provider)];
          const pick = order.find(hasQuota);
          if (!pick) { update({ route, error: "Todas as IAs estão sem cota agora. Veja ao lado quando cada uma volta." }); return; }
          if (pick !== route.provider) notes.push(`${names[route.provider]} está sem cota; usando ${names[pick]}.`);
          if (previous && previous.provider !== pick) notes.push(`${names[previous.provider]} está sem cota; seguindo com ${names[pick]}, sem o histórico anterior.`);
          provider = pick;
        }
      }
      // Continue this AI's own earlier conversation in this chat, if there is one.
      const resumeId = lastOf(provider)?.sessionId ?? null;
      const effort = validEffort[provider].includes(route.effort) ? route.effort : "medium";
      const chosen = chooseModel(provider, chat.quality, effort, catalog.current, quotasRef.current);
      update({ route: { ...route, provider, model: chosen.id, effort }, notes });
      const taskId = await launchAgent({ provider, prompt, cwd: workDir, model: chosen.id, effort, display_name: `${names[provider]} · ${chat.title === "Nova conversa" ? titleFrom(prompt) : chat.title}`, resume_id: resumeId });
      update({ attempts: [{ provider, taskId, model: chosen.id, modelName: chosen.name }] });
    } catch (reason) { update({ error: String(reason) }); }
    finally { setBusy((b) => ({ ...b, [chatId]: false })); }
  }

  function createChat() {
    const c = newChat(active?.folder ?? "", active?.quality ?? "balanced");
    setChats((all) => [c, ...all]);
    setActiveId(c.id);
  }
  function removeChat(id: string) {
    setChats((all) => { const rest = all.filter((c) => c.id !== id); return rest.length ? rest : [newChat()]; });
    if (id === activeId) setActiveId(chats.find((c) => c.id !== id)?.id ?? "");
  }
  const setFolder = (id: string, folder: string) => patchChat(id, (c) => ({ ...c, folder }));
  const setQuality = (id: string, quality: Quality) => patchChat(id, (c) => ({ ...c, quality }));

  return { chats, active, activeId: active?.id, setActiveId, createChat, removeChat, setFolder, setQuality, send, busy, quotas, quotasAt, refreshQuotas, streams, fallbackDir };
}
