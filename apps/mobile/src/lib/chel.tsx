import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { forgetRemoteConnection, loadRemoteConnection, pairWithCode, pairWithHost, remoteFetch, type RemoteConnection } from "./remote";

export type ProviderId = "claude_code" | "codex" | "antigravity";
export type Turn = { id: string; prompt: string; at: number; notes: string[]; error: string | null; provider: ProviderId | null; model: string | null; effort: string | null; answer: string; status: string | null; task_id: string | null; steps?: string[]; denials?: Array<{ tool: string; target: string; dir: string | null }>; retried?: boolean };
export type Chat = { id: string; title: string; folder: string; pinned?: boolean; updatedAt: number; turns: Turn[] };
export type Working = { chat_id: string; chat_title: string; provider: ProviderId | null; model: string | null; effort: string | null; since: number; task_id: string; status: string; subagents: Array<{ description: string; kind: string; done: boolean }> };
export type QuotaWindow = { label: string; remaining_pct: number; resets: string | null };
export type Quota = { provider: ProviderId; available: boolean; windows: QuotaWindow[]; error: string | null };
export type ChelState = { chats: Chat[]; working: Working[]; quotas: Quota[]; default_folder?: string; updated_at?: number };

export const brand: Record<ProviderId, { name: string; color: string; soft: string; glyph: string }> = {
  claude_code: { name: "Claude", color: "#D97757", soft: "rgba(217,119,87,0.13)", glyph: "✳" },
  codex: { name: "Codex", color: "#F4F4F5", soft: "rgba(244,244,245,0.08)", glyph: "⬡" },
  antigravity: { name: "Antigravity", color: "#4285F4", soft: "rgba(66,133,244,0.13)", glyph: "◉" },
};
export const effortName: Record<string, string> = { low: "baixo", medium: "médio", high: "alto", xhigh: "muito alto", max: "máximo" };
export const finished = ["succeeded", "failed", "cancelled", "quota_exceeded"];

type Status = "loading" | "unpaired" | "online" | "offline";
type Ctx = {
  status: Status; connection: RemoteConnection | null; state: ChelState; error: string | null;
  connectWithCode: (code: string, name: string) => Promise<void>;
  connectWithQr: (payload: string, name: string) => Promise<void>;
  disconnect: () => Promise<void>;
  command: (cmd: Record<string, unknown>) => Promise<void>;
  refresh: () => Promise<void>;
};

const empty: ChelState = { chats: [], working: [], quotas: [] };
const ChelContext = createContext<Ctx | null>(null);

export function newId() { return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`; }

/** Keeps the phone in sync with the Chel on the computer (polls every 1.5 s while open). */
export function ChelProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [connection, setConnection] = useState<RemoteConnection | null>(null);
  const [state, setState] = useState<ChelState>(empty);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);

  const refresh = useCallback(async () => {
    if (!connection) return;
    try { setState(await remoteFetch<ChelState>("/api/v1/chat/state")); setStatus("online"); setError(null); }
    catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (/revogad|inválido/i.test(message)) { await forgetRemoteConnection(); setConnection(null); setStatus("unpaired"); }
      else { setStatus("offline"); setError(message); }
    }
  }, [connection]);

  useEffect(() => { void loadRemoteConnection().then((c) => { setConnection(c); setStatus(c ? "offline" : "unpaired"); }); }, []);
  useEffect(() => {
    if (!connection) return;
    void refresh();
    const timer = setInterval(() => { if (active.current) void refresh(); }, 1500);
    const sub = AppState.addEventListener("change", (s) => { active.current = s === "active"; if (active.current) void refresh(); });
    return () => { clearInterval(timer); sub.remove(); };
  }, [connection, refresh]);

  const value: Ctx = {
    status, connection, state, error, refresh,
    connectWithCode: async (code, name) => { const c = await pairWithCode(code, name); setConnection(c); setStatus("offline"); },
    connectWithQr: async (payload, name) => { const c = await pairWithHost(payload, name); setConnection(c); setStatus("offline"); },
    disconnect: async () => { await forgetRemoteConnection(); setConnection(null); setState(empty); setStatus("unpaired"); },
    command: async (cmd) => { await remoteFetch("/api/v1/chat/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cmd) }); setTimeout(() => void refresh(), 250); },
  };
  return <ChelContext.Provider value={value}>{children}</ChelContext.Provider>;
}

export function useChel() {
  const ctx = useContext(ChelContext);
  if (!ctx) throw new Error("ChelProvider ausente");
  return ctx;
}

/** Reads the choice box the AI may end its answer with (a ```opcoes block). */
export function parseChoices(answer: string): { text: string; question: string; options: string[] } | null {
  const m = answer.match(/```opc(?:oes|ões)\s*\n([\s\S]*?)```\s*$/i);
  if (!m) return null;
  const lines = m[1].split("\n").map((l) => l.trim()).filter(Boolean);
  const isOption = (l: string) => /^[-*•]|^\d+[.)]/.test(l);
  const options = lines.filter(isOption).map((l) => l.replace(/^([-*•]|\d+[.)])\s*/, ""));
  const question = lines.find((l) => !isOption(l)) ?? "";
  return options.length ? { text: answer.slice(0, m.index).trim(), question, options } : null;
}
