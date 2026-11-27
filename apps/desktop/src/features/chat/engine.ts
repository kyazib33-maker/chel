import type { ModelCatalog, ProviderId, ProviderQuota, RouteRecommendation, TaskEvent } from "../../lib/tauri";

export type Quality = "economy" | "balanced" | "maximum";
export type Attempt = { provider: ProviderId; taskId: string; sessionId?: string; model?: string | null; modelName?: string };
export type Turn = { id: string; prompt: string; route: RouteRecommendation | null; attempts: Attempt[]; error: string | null; notes: string[]; at: number; answer?: string; cwd?: string };
export type Chat = { id: string; title: string; turns: Turn[]; folder: string; quality: Quality; updatedAt: number; pinned?: boolean };
export type Subagent = { id: string; taskId: string; description: string; kind: string; done: boolean };

export const names: Record<ProviderId, string> = { claude_code: "Claude", codex: "Codex", antigravity: "Antigravity" };
export const qualityLabel: Record<Quality, string> = { economy: "Econômico", balanced: "Equilibrado", maximum: "Caprichado" };
export const finished = ["succeeded", "failed", "cancelled", "quota_exceeded"];
export const validEffort: Record<ProviderId, string[]> = { claude_code: ["low", "medium", "high", "max"], codex: ["low", "medium", "high", "xhigh"], antigravity: ["low", "medium", "high", "xhigh", "max"] };

function json(line: string): Record<string, any> | null {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  try { return JSON.parse(t); } catch { return null; }
}

/** Human-readable failure reason in CLI output (quota, login…). */
function failureText(line: string): string | null {
  const d = json(line);
  if (d) return d.event === "result" && d.result?.error ? d.result.error : d.type === "result" && d.is_error ? (d.result ?? null) : null;
  const t = line.trim();
  return /quota|limit|rate|unauthori|login|not logged/i.test(t) && !t.startsWith("AGY_ERROR") ? t.replace(/^error:\s*/i, "") : null;
}

/** "claude-sonnet-5-5" → "Sonnet 5.5", "claude-opus-4-6-thinking" → "Opus 4.6". */
export function prettyModel(id: string): string {
  const m = id.match(/^claude-([a-z]+)-(\d+)-(\d+)/);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`;
  if (/^(fable|opus|sonnet|haiku)$/.test(id)) return id[0].toUpperCase() + id.slice(1);
  return id;
}

/** Everything the chat needs from the raw CLI output of all tasks. */
export function readStreams(events: TaskEvent[]) {
  const replies = new Map<string, string[]>();
  const failures = new Map<string, string>();
  const sessions = new Map<string, string>();
  const models = new Map<string, string>();
  const subagents = new Map<string, Subagent>();
  for (const event of events) {
    if (event.payload.type !== "output") continue;
    const line = event.payload.data.line;
    const d = json(line);
    if (d) {
      if (d.type === "system" && d.subtype === "init") {
        if (d.session_id) sessions.set(event.task_id, d.session_id);
        if (typeof d.model === "string") models.set(event.task_id, d.model);
        continue;
      }
      if (d.type === "thread.started" && d.thread_id) { sessions.set(event.task_id, d.thread_id); continue; }
      if (d.event === "init" && d.conversation_id) { sessions.set(event.task_id, d.conversation_id); continue; }
      // Claude subagents: an Agent/Task tool call starts one; its tool_result ends it.
      const content = Array.isArray(d.message?.content) ? d.message.content : [];
      for (const c of content) {
        if (c.type === "tool_use" && (c.name === "Agent" || c.name === "Task")) {
          subagents.set(c.id, { id: c.id, taskId: event.task_id, description: c.input?.description ?? String(c.input?.prompt ?? "").slice(0, 60), kind: c.input?.subagent_type ?? "agente", done: false });
        }
        if (c.type === "tool_result" && subagents.has(c.tool_use_id)) subagents.get(c.tool_use_id)!.done = true;
      }
      // Antigravity subagents
      if (d.event === "step_update" && /subagent/i.test(JSON.stringify(d.step_update?.step_type ?? ""))) {
        const id = `${event.task_id}:${d.step_update.step_index}`;
        subagents.set(id, { id, taskId: event.task_id, description: "Subagente", kind: "subagente", done: d.step_update.state === "DONE" });
      }
    }
    const why = failureText(line);
    if (why) { failures.set(event.task_id, why); continue; }
    if (event.payload.data.stream !== "stdout") continue;
    let piece: string | null = null;
    if (!d) piece = line.trim() || null;
    else if (d.type === "assistant" && content(d)) piece = content(d);
    else if (d.type === "item.completed" && d.item?.type === "agent_message") piece = d.item.text ?? null;
    else if (d.msg?.type === "agent_message") piece = d.msg.message ?? null;
    else if (d.event === "result" && d.result?.response) piece = d.result.response;
    if (piece) replies.set(event.task_id, [...(replies.get(event.task_id) ?? []), piece]);
  }
  return { replies, failures, sessions, models, subagents };
}

function content(d: Record<string, any>): string | null {
  const text = (d.message?.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");
  return text || null;
}

/** Top-of-line models Chel never uses: it always stays economical. */
const TOP_TIER = /fable|mythos|opus|astra|argon|ultra|\bpro\b|-max\b/i;

/** Effort follows how complex the request is, capped at "high". */
export function effortFor(complexity: string | undefined): string {
  return complexity === "high" ? "high" : complexity === "low" ? "low" : "medium";
}

/** Picks the cheapest model that fits the task's complexity — never a top-tier one. */
export function chooseModel(provider: ProviderId, complexity: string | undefined, catalog: ModelCatalog | null, quotas: ProviderQuota[]): { id: string | null; name: string } {
  const effort = effortFor(complexity);
  if (provider === "claude_code") {
    const alias = complexity === "low" ? "haiku" : "sonnet";
    return { id: alias, name: prettyModel(alias) };
  }
  if (provider === "codex") {
    const allowed = (catalog?.codex ?? []).filter((m) => !TOP_TIER.test(m.id) && !TOP_TIER.test(m.name));
    const fallback = allowed.find((m) => m.id === catalog?.codex_default) ?? allowed[0];
    // The catalog lists newer/larger models first: simple tasks take the last (smallest) one.
    const chosen = complexity === "low" ? allowed[allowed.length - 1] ?? fallback : fallback;
    return chosen ? { id: chosen.id, name: chosen.name } : { id: null, name: "Codex" };
  }
  const list = (catalog?.antigravity ?? []).filter((m) => !TOP_TIER.test(m.id));
  const windows = quotas.find((q) => q.provider === "antigravity")?.windows ?? [];
  const room = (family: string) => { const w = windows.filter((x) => x.label.startsWith(family)); return w.length === 0 || w.every((x) => x.remaining_pct > 0); };
  const candidates = room("Gemini")
    ? complexity === "high" ? [`gemini-4-hydrogen-${effort}`, `gemini-3.8-flash-${effort}`] : [`gemini-3.8-flash-${effort}`, `gemini-4-hydrogen-${effort}`]
    : ["claude-sonnet-4-6"];
  const found = candidates.map((c) => list.find((m) => m.id === c)).find(Boolean) ?? list[0];
  return found ? { id: found.id, name: found.name.replace(/\s*\((Thinking|Low|Medium|High|XHigh)\)$/i, "") } : { id: null, name: "Antigravity" };
}

/** "use o codex", "pede pro claude", "@gemini"… → the AI the user asked for, if any. */
export function requestedProvider(prompt: string): ProviderId | null {
  const p = prompt.toLowerCase();
  const target = "(claude|codex|gpt|chatgpt|antigravity|agy|gemini)";
  const asked = p.match(new RegExp(`(?:^|\\s)@${target}\\b`)) ??
    p.match(new RegExp(`\\b(?:us[ae]r?|utiliz[ae]r?|com|pelo|pela|via|chama|chamar|pede pr[ao]|pe[çc]a pr[ao]|troc[ae]r? (?:para|pro|pra)|mud[ae]r? (?:para|pro|pra)|pass[ae]r? (?:para|pro|pra)|vai de|agora (?:o|com o))\\s+(?:o\\s+|a\\s+)?${target}\\b`));
  if (!asked) return null;
  const who = asked[asked.length - 1];
  return who === "claude" ? "claude_code" : who === "codex" || who === "gpt" || who === "chatgpt" ? "codex" : "antigravity";
}

export function newChat(folder = "", quality: Quality = "balanced"): Chat {
  return { id: crypto.randomUUID(), title: "Nova conversa", turns: [], folder, quality, updatedAt: Date.now() };
}

export function titleFrom(prompt: string): string {
  const t = prompt.replace(/\s+/g, " ").trim();
  return t.length > 42 ? `${t.slice(0, 40)}…` : t || "Nova conversa";
}
