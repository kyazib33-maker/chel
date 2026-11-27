import { useCallback, useEffect, useState } from "react";
import { Database, RefreshCw, RotateCcw, Play, Download } from "lucide-react";
import { desktopBridgeAvailable, listManagedSessions, importAntigravityWorkspaceSession, resumeAntigravitySession, resumeClaudeSession, resumeCodexSession, type ManagedSession } from "../../lib/tauri";

const providerName: Record<ManagedSession["provider"], string> = {
  claude_code: "Claude Code", codex: "Codex App Server", antigravity: "Antigravity",
};
const statusLabel: Record<string, string> = {
  starting: "Iniciando", running: "Executando", idle: "Ociosa", awaiting_approval: "Aguardando aprovação",
  interrupted: "Interrompida", disconnected: "Desconectada", stopped: "Encerrada", failed: "Falhou",
};

export default function SessionCenter() {
  const [sessions, setSessions] = useState<ManagedSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [workspacePath, setWorkspacePath] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try { setSessions(await listManagedSessions()); setError(null); }
    catch (reason) { setError(String(reason)); }
  }, []);
  async function importAntigravity() {
    if (!workspacePath.trim()) return;
    try { await importAntigravityWorkspaceSession(workspacePath.trim()); setWorkspacePath(""); await refresh(); }
    catch (reason) { setError(String(reason)); }
  }
  async function resume(session: ManagedSession) {
    const prompt = window.prompt("Instrução para continuar esta sessão:", "Continue o trabalho anterior. Primeiro verifique o estado atual do projeto e identifique o que falta concluir.");
    if (!prompt?.trim()) return;
    setBusyId(session.id); setError(null);
    try {
      if (session.provider === "claude_code") await resumeClaudeSession(session.id, prompt);
      else if (session.provider === "codex") await resumeCodexSession(session.id, prompt);
      else await resumeAntigravitySession(session.id, prompt);
      await refresh();
    } catch (reason) { setError(String(reason)); }
    finally { setBusyId(null); }
  }
  useEffect(() => {
    if (!desktopBridgeAvailable) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return <section className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-[10px] uppercase tracking-[0.2em] text-muted">Session Manager</p><h1 className="mt-1 text-xl font-semibold">Central de sessões</h1><p className="mt-1 text-xs text-muted">Registro persistente das sessões nativas dos provedores.</p></div><button onClick={() => void refresh()} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-xs text-muted"><RefreshCw size={13}/>Atualizar</button></div>
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel p-3">
      <input value={workspacePath} onChange={(event) => setWorkspacePath(event.target.value)} placeholder="Caminho do workspace para importar conversa Antigravity" className="min-w-[260px] flex-1 rounded-lg border border-line bg-canvas px-3 py-2 text-xs outline-none" />
      <button onClick={() => void importAntigravity()} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-xs"><Download size={13}/>Importar Antigravity</button>
    </div>
    {error && <p className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-300">{error}</p>}
    {sessions.length === 0 ? <div className="rounded-xl border border-line bg-panel p-12 text-center"><Database className="mx-auto mb-3 text-muted" size={24}/><p className="text-sm font-medium">Nenhuma sessão registrada</p><p className="mt-1 text-xs text-muted">Sessões iniciadas pelos painéis nativos aparecerão aqui.</p></div> : <div className="grid gap-3 xl:grid-cols-2">{sessions.map((session) => <article key={session.id} className="rounded-xl border border-line bg-panel p-4">
      <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-semibold">{providerName[session.provider]}</p><p className="mt-1 break-all font-mono text-[10px] text-muted">{session.id}</p></div><span className={`rounded-full border px-2 py-1 text-[10px] ${session.status === "running" ? "border-emerald-500/30 text-emerald-300" : session.status === "interrupted" ? "border-amber-500/30 text-amber-300" : "border-line text-muted"}`}>{statusLabel[session.status] ?? session.status}</span></div>
      <p className="mt-3 truncate text-[11px] text-zinc-300" title={session.cwd}>{session.cwd}</p>
      <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-muted"><span>Modelo: {session.model ?? "Padrão"}</span><span>Recuperação: {session.recovery_mode === "native_resume" ? "Nativa" : session.recovery_mode === "metadata_only" ? "Metadados" : "Indisponível"}</span></div>
      <div className="mt-3 rounded-lg bg-canvas p-3"><div className="mb-1 flex items-center gap-2 text-[10px] font-semibold text-muted"><RotateCcw size={12}/>Recuperação</div><p className="text-[10px] leading-5 text-zinc-400">{session.recovery_note}</p>{session.external_session_id && <p className="mt-2 break-all font-mono text-[10px] text-muted">ID nativo: {session.external_session_id}</p>}</div>
      {session.last_error && <p className="mt-2 text-[10px] text-rose-300">{session.last_error}</p>}
      {session.recovery_mode === "native_resume" && session.external_session_id && !["running", "starting"].includes(session.status) && <button disabled={busyId === session.id} onClick={() => void resume(session)} className="mt-3 flex items-center gap-2 rounded-lg border border-violet-400/30 bg-violet-400/5 px-3 py-2 text-xs text-violet-200 disabled:opacity-50"><Play size={12}/>{busyId === session.id ? "Retomando..." : "Retomar sessão"}</button>}
    </article>)}</div>}
  </section>;
}
