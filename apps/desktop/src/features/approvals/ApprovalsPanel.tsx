import { useCallback, useEffect, useState } from "react";
import { Check, RefreshCw, ShieldAlert, X } from "lucide-react";
import { decideApproval, listApprovals, type PermissionRequest } from "../../lib/tauri";

const actionLabel: Record<PermissionRequest["action"], string> = {
  read: "Leitura", write: "Escrita", execute: "Execução", network: "Rede", destructive: "Destrutiva",
};
const statusLabel: Record<PermissionRequest["status"], string> = {
  pending: "Pendente", approved: "Aprovada", denied: "Negada", expired: "Expirada",
};

export default function ApprovalsPanel() {
  const [items, setItems] = useState<PermissionRequest[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try { setItems(await listApprovals()); setError(null); }
    catch (reason) { setError(String(reason)); }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  async function decide(id: string, approve: boolean) {
    setBusy(id); setError(null);
    try { await decideApproval(id, approve); await refresh(); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(null); }
  }
  const pending = items.filter((item) => item.status === "pending");
  const history = items.filter((item) => item.status !== "pending").slice(0, 30);
  return <section className="space-y-5">
    <div className="flex items-center justify-between"><div><p className="text-[10px] uppercase tracking-[0.2em] text-muted">Human in the loop</p><h1 className="mt-1 text-xl font-semibold">Central de aprovações</h1><p className="mt-1 text-xs text-muted">Políticas, solicitações e decisões registradas pelo Host.</p></div><button onClick={() => void refresh()} className="rounded-lg border border-line p-2 text-muted hover:text-white"><RefreshCw size={15} /></button></div>
    {error && <p className="rounded-lg border border-rose-500/20 bg-rose-500/5 p-3 text-xs text-rose-300">{error}</p>}
    <div className="flex items-center gap-2 text-xs text-muted"><ShieldAlert size={14} />{pending.length} solicitações aguardando decisão</div>
    {pending.length === 0 ? <div className="rounded-xl border border-line bg-panel p-8 text-center"><p className="text-sm font-medium">Nenhuma solicitação pendente</p><p className="mt-2 text-xs text-muted">Solicitações nativas do Codex aparecem aqui e a decisão é enviada de volta à sessão pausada.</p></div> : pending.map((item) => <article key={item.id} className="rounded-xl border border-amber-500/20 bg-panel p-5">
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">{item.tool_name}</h2><span className="rounded-full bg-amber-500/10 px-2.5 py-1 text-[10px] text-amber-300">{actionLabel[item.action]}</span></div>
      <p className="mt-3 text-xs text-zinc-300">{item.summary}</p><p className="mt-2 text-[10px] text-muted">{item.provider} · tarefa {item.task_id.slice(0, 8)} · expira {new Date(item.expires_at).toLocaleString()}</p>
      <pre className="mt-3 max-h-48 overflow-auto rounded-lg bg-canvas p-3 text-[10px] leading-5 text-zinc-300">{item.input_preview}</pre>
      <div className="mt-4 flex justify-end gap-2"><button disabled={busy === item.id} onClick={() => void decide(item.id, false)} className="flex items-center gap-2 rounded-lg border border-rose-500/30 px-3 py-2 text-xs text-rose-300 disabled:opacity-40"><X size={13} />Negar</button><button disabled={busy === item.id} onClick={() => void decide(item.id, true)} className="flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-zinc-950 disabled:opacity-40"><Check size={13} />Aprovar</button></div>
    </article>)}
    {history.length > 0 && <div><h2 className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-muted">Histórico recente</h2><div className="overflow-hidden rounded-xl border border-line">{history.map((item) => <div key={item.id} className="flex items-center justify-between border-b border-line bg-panel px-4 py-3 last:border-0"><div><p className="text-xs">{item.tool_name} · {actionLabel[item.action]}</p><p className="mt-1 text-[9px] text-muted">{new Date(item.decided_at ?? item.expires_at).toLocaleString()}</p></div><span className="text-[10px] text-muted">{statusLabel[item.status]}</span></div>)}</div></div>}
    <p className="text-[10px] leading-5 text-muted">As decisões são registradas no Host. Para solicitações nativas do Codex, aprovar ou negar responde diretamente ao pedido JSON-RPC que mantém a sessão pausada. Outros provedores dependem de seus próprios adapters interativos.</p>
  </section>;
}
