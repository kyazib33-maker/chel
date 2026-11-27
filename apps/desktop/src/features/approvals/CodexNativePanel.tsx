import { useEffect, useState } from "react";
import { Play, RefreshCw, ShieldAlert, Square } from "lucide-react";
import {
  listCodexSessions, onCodexEvent, startCodexSession, stopCodexSession,
  type CodexEvent, type CodexSessionInfo,
} from "../../lib/tauri";

export default function CodexNativePanel() {
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [sandbox, setSandbox] = useState("workspace-write");
  const [sessions, setSessions] = useState<CodexSessionInfo[]>([]);
  const [events, setEvents] = useState<CodexEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try { setSessions(await listCodexSessions()); }
    catch (reason) { setError(String(reason)); }
  }

  useEffect(() => {
    void refresh();
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void onCodexEvent((event) => {
      if (["transport/closed", "turn/completed", "turn/started"].includes(event.method)) void refresh();
      setEvents((current) => [...current.slice(-99), event]);
    })
      .then((stop) => { if (disposed) stop(); else unlisten = stop; })
      .catch((reason: unknown) => setError(String(reason)));
    return () => { disposed = true; unlisten?.(); };
  }, []);

  async function start() {
    if (!cwd.trim() || !prompt.trim()) return;
    setBusy(true); setError(null);
    try {
      await startCodexSession({ cwd, prompt, model: model.trim() || null, sandbox, persistent: true });
      setPrompt(""); await refresh();
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  const approvals = events.filter((event) => event.request_id && [
    "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval",
  ].includes(event.method));

  return <section className="space-y-5">
    <div className="rounded-xl border border-line bg-panel p-5">
      <div className="mb-4 flex items-center gap-2"><Play size={16} className="text-accent" /><h2 className="text-sm font-semibold">Codex App Server nativo</h2></div>
      <p className="mb-4 text-xs leading-5 text-slate-400">Sessões JSON-RPC bidirecionais com aprovação nativa do Codex. Reutiliza a autenticação local já configurada no CLI.</p>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-[10px] text-muted">Diretório absoluto<input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="C:\Projetos\meu-app" className={fieldClass} /></label>
        <label className="text-[10px] text-muted">Modelo (opcional)<input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Padrão do Codex" className={fieldClass} /></label>
        <label className="text-[10px] text-muted">Sandbox<select value={sandbox} onChange={(e) => setSandbox(e.target.value)} className={fieldClass}><option value="read-only">read-only</option><option value="workspace-write">workspace-write</option><option value="danger-full-access">danger-full-access</option></select></label>
        <label className="text-[10px] text-muted md:col-span-2">Prompt<textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} placeholder="Descreva a tarefa..." className={`${fieldClass} resize-y`} /></label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3"><button disabled={busy || !cwd.trim() || !prompt.trim()} onClick={() => void start()} className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-xs font-semibold text-zinc-950 disabled:opacity-40"><Play size={13} />{busy ? "Iniciando..." : "Iniciar sessão Codex"}</button><button onClick={() => void refresh()} className="rounded-lg border border-line p-2 text-slate-300 hover:bg-canvas"><RefreshCw size={14} /></button></div>
      {error && <p className="mt-3 break-words text-xs text-rose-300">{error}</p>}
    </div>

    <div className="rounded-xl border border-line bg-panel p-5"><h3 className="mb-3 text-xs font-semibold">Sessões ativas ({sessions.length})</h3>
      {sessions.length === 0 ? <p className="text-xs text-slate-500">Nenhuma sessão nativa iniciada.</p> : <div className="space-y-2">{sessions.map((session) => <div key={session.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-canvas p-3"><div className="min-w-0"><p className="text-xs font-medium">{session.thread_id || session.id}</p><p className="truncate text-[10px] text-slate-500">{session.cwd} · {session.status}</p></div><button onClick={() => void stopCodexSession(session.id).then(refresh).catch((reason) => setError(String(reason)))} className="flex items-center gap-1 rounded-md border border-line px-2 py-1.5 text-[10px] text-slate-300 hover:text-white"><Square size={11} /> Encerrar</button></div>)}</div>}
    </div>

    <div className="rounded-xl border border-line bg-panel p-5"><div className="mb-3 flex items-center gap-2"><ShieldAlert size={15} className="text-amber-300" /><h3 className="text-xs font-semibold">Aprovações encaminhadas ({approvals.length})</h3></div>
      <p className="text-xs leading-5 text-slate-400">As solicitações nativas do Codex são encaminhadas automaticamente para a Central unificada de aprovações. Decida por lá para manter o mesmo registro e permitir que o Mobile também responda à sessão pausada.</p>
      {approvals.length > 0 ? <p className="mt-2 text-[10px] text-amber-300">Há {approvals.length} evento(s) de aprovação recebidos nesta sessão.</p> : null}
    </div>
  </section>;
}

const fieldClass = "mt-1.5 w-full rounded-lg border border-line bg-canvas px-3 py-2.5 text-xs text-zinc-100 outline-none focus:border-accent";
