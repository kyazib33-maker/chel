import { useEffect, useState } from "react";
import { CheckCircle2, CircleHelp, Terminal } from "lucide-react";
import { desktopBridgeAvailable } from "../../lib/tauri";
import { invoke } from "@tauri-apps/api/core";

type Provider = { provider: string; display_name: string; launch: boolean; streaming: boolean; persistent_sessions: boolean; native_resume: boolean; interactive_approvals: boolean; remote_resume: boolean; integration_mode: string; notes: string };
const labels: Array<[keyof Provider, string]> = [["launch","Execução local"],["streaming","Streaming"],["persistent_sessions","Sessões persistentes"],["native_resume","Retomada nativa"],["interactive_approvals","Aprovação interativa"],["remote_resume","Retomada pelo Mobile"]];
export default function ProviderCatalog() {
  const [items,setItems] = useState<Provider[]>([]); const [error,setError] = useState<string|null>(null);
  useEffect(()=>{ if(!desktopBridgeAvailable)return; void invoke<Provider[]>("list_provider_capabilities").then(setItems).catch(e=>setError(String(e))); },[]);
  return <section className="space-y-5"><div><p className="text-[10px] uppercase tracking-[.2em] text-violet-300">Runtime / provider catalog</p><h1 className="mt-1 text-xl font-semibold">Capacidades dos provedores</h1><p className="mt-1 text-xs text-muted">Matriz explícita do que está integrado no Orchestrator, sem presumir recursos do CLI.</p></div>
    {error && <p className="text-xs text-rose-300">{error}</p>}
    <div className="grid gap-4 xl:grid-cols-3">{items.map(p=><article key={p.provider} className="rounded-xl border border-line bg-panel p-5"><div className="flex items-center gap-2"><Terminal size={16} className="text-violet-300"/><h2 className="text-sm font-semibold">{p.display_name}</h2></div><p className="mt-2 text-[10px] text-muted">{p.integration_mode}</p><div className="mt-4 grid grid-cols-2 gap-2">{labels.map(([key,label])=><div key={key} className="flex items-center gap-2 rounded-lg bg-canvas p-2 text-[10px]">{p[key] ? <CheckCircle2 size={13} className="text-emerald-400"/> : <CircleHelp size={13} className="text-amber-300"/>}<span className="text-slate-300">{label}</span></div>)}</div><p className="mt-4 text-xs leading-5 text-slate-400">{p.notes}</p></article>)}</div>
    {!desktopBridgeAvailable && <p className="text-xs text-amber-300">Abra o Desktop pelo Tauri para consultar o catálogo local.</p>}
  </section>;
}
