import { useCallback, useEffect, useState } from "react";
import { MessageSquare, Play, RefreshCw, Square } from "lucide-react";
import { desktopBridgeAvailable, listClaudeSessions, onClaudeEvent, sendClaudeMessage, startClaudeSession, stopClaudeSession, type ClaudeEvent, type ClaudeSessionInfo } from "../../lib/tauri";

export default function ClaudeNativePanel() {
  const [sessions, setSessions] = useState<ClaudeSessionInfo[]>([]);
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("medium");
  const [permissionMode, setPermissionMode] = useState("default");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [events, setEvents] = useState<ClaudeEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => { try { setSessions(await listClaudeSessions()); setError(null); } catch (e) { setError(String(e)); } }, []);

  useEffect(() => {
    void refresh();
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void onClaudeEvent((event) => {
      setEvents((items) => [...items.slice(-299), event]);
      if (event.event_type === "transport/closed" || event.event_type === "result") void refresh();
    }).then((stop) => { if (disposed) stop(); else unlisten = stop; }).catch((e) => setError(String(e)));
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { disposed = true; unlisten?.(); window.clearInterval(timer); };
  }, [refresh]);

  async function start() {
    if (!cwd.trim() || !prompt.trim()) return;
    setBusy(true); setError(null);
    try {
      const session = await startClaudeSession({ cwd, prompt, model: model.trim() || null, effort, permission_mode: permissionMode });
      setActiveId(session.id); setPrompt(""); await refresh();
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  async function send() {
    if (!activeId || !prompt.trim()) return;
    setBusy(true); setError(null);
    try { await sendClaudeMessage(activeId, prompt); setPrompt(""); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  const activeEvents = events.filter((event) => event.session_id === activeId);
  return <section className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
    <div className="space-y-4">
      <div className="rounded-xl border border-line bg-panel p-5">
        <div className="mb-4 flex items-center justify-between"><div><p className="text-[10px] uppercase tracking-[0.2em] text-muted">Claude Code · stream-json</p><h1 className="mt-1 text-lg font-semibold">Sessões nativas</h1></div><button onClick={() => void refresh()} className="rounded-lg border border-line p-2 text-muted"><RefreshCw size={14}/></button></div>
        <label className="mb-3 block text-[10px] text-muted">Diretório absoluto<input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="C:\\Projetos\\meu-app" className="mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2.5 text-xs text-white"/></label>
        <label className="mb-3 block text-[10px] text-muted">Modelo<input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Padrão da conta" className="mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2.5 text-xs text-white"/></label>
        <div className="mb-3 grid grid-cols-2 gap-2"><label className="text-[10px] text-muted">Effort<select value={effort} onChange={(e) => setEffort(e.target.value)} className="mt-1 w-full rounded-lg border border-line bg-canvas px-2 py-2 text-xs text-white">{["low","medium","high","max"].map((v) => <option key={v}>{v}</option>)}</select></label><label className="text-[10px] text-muted">Permissões<select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)} className="mt-1 w-full rounded-lg border border-line bg-canvas px-2 py-2 text-xs text-white"><option value="default">Manual</option><option value="acceptEdits">Aceitar edições</option><option value="plan">Planejamento</option><option value="auto">Auto</option><option value="dontAsk">Não perguntar</option></select></label></div>
        <label className="block text-[10px] text-muted">Prompt inicial<textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={5} placeholder="Descreva o trabalho..." className="mt-1 w-full resize-y rounded-lg border border-line bg-canvas px-3 py-2.5 text-xs text-white"/></label>
        <button disabled={!desktopBridgeAvailable || busy || !cwd.trim() || !prompt.trim()} onClick={() => void start()} className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-3 text-xs font-semibold text-zinc-950 disabled:opacity-40"><Play size={13}/>{busy ? "Iniciando..." : "Iniciar sessão Claude"}</button>
        {error && <p className="mt-3 break-words text-xs text-rose-300">{error}</p>}
      </div>
      <div className="rounded-xl border border-line bg-panel p-4"><h2 className="mb-3 text-xs font-semibold">Sessões no Host</h2>{sessions.length === 0 ? <p className="text-xs text-muted">Nenhuma sessão criada por este adapter.</p> : sessions.map((s) => <button key={s.id} onClick={() => setActiveId(s.id)} className={`mb-2 w-full rounded-lg border p-3 text-left ${activeId === s.id ? "border-accent bg-accent/5" : "border-line bg-canvas"}`}><div className="flex items-center justify-between"><span className="text-xs font-medium">{s.model ?? "Claude Code"}</span><span className="text-[10px] text-muted">{s.status}</span></div><p className="mt-1 truncate text-[10px] text-muted">{s.cwd}</p></button>)}</div>
    </div>
    <div className="rounded-xl border border-line bg-panel p-5">
      <div className="mb-4 flex items-center justify-between"><div><p className="text-[10px] uppercase tracking-widest text-muted">Interactive host</p><h2 className="mt-1 text-sm font-semibold">Stream de eventos</h2></div>{activeId && <button onClick={() => void stopClaudeSession(activeId).then(refresh)} className="flex items-center gap-2 rounded-lg border border-rose-500/30 px-3 py-2 text-xs text-rose-300"><Square size={12}/>Encerrar sessão</button>}</div>
      {activeId && <div className="mb-4 flex gap-2"><input value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} placeholder="Enviar próxima mensagem..." className="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-3 py-2.5 text-xs text-white"/><button disabled={busy || !prompt.trim()} onClick={() => void send()} className="rounded-lg bg-accent px-3 text-zinc-950 disabled:opacity-40"><MessageSquare size={14}/></button></div>}
      <div className="max-h-[650px] space-y-2 overflow-auto">{activeEvents.length === 0 ? <p className="py-16 text-center text-xs text-muted">Selecione ou inicie uma sessão para acompanhar eventos.</p> : activeEvents.map((event, i) => <article key={`${event.session_id}-${i}`} className="rounded-lg border border-line bg-canvas p-3"><div className="mb-2 flex justify-between"><span className="text-[10px] font-semibold text-accent">{event.event_type}</span></div><pre className="whitespace-pre-wrap break-words text-[10px] leading-5 text-zinc-300">{JSON.stringify(event.payload, null, 2)}</pre></article>)}</div>
    </div>
  </section>;
}
