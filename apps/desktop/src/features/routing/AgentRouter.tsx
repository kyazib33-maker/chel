import { useState } from "react";
import { ArrowRight, BrainCircuit, GitBranch, ShieldCheck } from "lucide-react";
import { buildDelegationBlueprint, compileAndSaveDelegationWorkflow, recommendAgentRoute, type DelegationBlueprint, type RouteRecommendation, type ProviderId } from "../../lib/tauri";

const names: Record<ProviderId, string> = { claude_code: "Claude Code", codex: "Codex CLI", antigravity: "Antigravity" };
const panel = "rounded-xl border border-line bg-panel p-5";
const input = "mt-1.5 w-full rounded-lg border border-line bg-canvas px-3 py-2.5 text-xs text-zinc-100 outline-none focus:border-accent";

export default function AgentRouter() {
  const [prompt, setPrompt] = useState("");
  const [quality, setQuality] = useState<"economy" | "balanced" | "maximum">("balanced");
  const [preferred, setPreferred] = useState<ProviderId | "auto">("auto");
  const [allowAntigravity, setAllowAntigravity] = useState(true);
  const [projectPath, setProjectPath] = useState("");
  const [savedWorkflow, setSavedWorkflow] = useState("");
  const [route, setRoute] = useState<RouteRecommendation | null>(null);
  const [blueprint, setBlueprint] = useState<DelegationBlueprint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function analyze() {
    if (!prompt.trim()) return;
    setBusy(true); setError(null); setBlueprint(null); setSavedWorkflow("");
    try {
      const request = { prompt, preferred_provider: preferred === "auto" ? null : preferred, quality, allow_antigravity: allowAntigravity };
      const result = await recommendAgentRoute(request);
      setRoute(result);
      setBlueprint(await buildDelegationBlueprint(prompt, request));
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  async function saveAsWorkflow() {
    if (!route || !blueprint || !prompt.trim()) return;
    setBusy(true); setError(null); setSavedWorkflow("");
    try {
      const request = { prompt, preferred_provider: preferred === "auto" ? null : preferred, quality, allow_antigravity: allowAntigravity };
      const workflow = await compileAndSaveDelegationWorkflow(prompt, request, projectPath.trim() || null);
      setSavedWorkflow(`Workflow "${workflow.name}" salvo com ${workflow.nodes.length} agentes. Abra a aba Workflows para executar.`);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  return <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_390px]">
    <section className={panel}>
      <div className="mb-4 flex items-center gap-2"><BrainCircuit size={18} className="text-accent"/><div><h2 className="text-sm font-semibold">Roteador inteligente</h2><p className="text-[10px] text-muted">Recomendação explicável para os CLIs locais</p></div></div>
      <label className="block text-[10px] text-muted">Objetivo da tarefa<textarea value={prompt} onChange={e=>setPrompt(e.target.value)} rows={8} placeholder="Descreva o que precisa ser feito, restrições e resultado esperado..." className={`${input} resize-y`}/></label>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-[10px] text-muted">Política de qualidade<select value={quality} onChange={e=>setQuality(e.target.value as typeof quality)} className={input}><option value="economy">Economia — menor esforço adequado</option><option value="balanced">Equilibrado</option><option value="maximum">Máxima qualidade — maior esforço</option></select></label>
        <label className="text-[10px] text-muted">Preferência de provedor<select value={preferred} onChange={e=>setPreferred(e.target.value as typeof preferred)} className={input}><option value="auto">Automático</option><option value="claude_code">Claude Code</option><option value="codex">Codex CLI</option><option value="antigravity">Antigravity</option></select></label>
      </div>
      <label className="mt-3 flex items-center gap-2 text-[11px] text-slate-300"><input type="checkbox" checked={allowAntigravity} onChange={e=>setAllowAntigravity(e.target.checked)}/> Incluir Antigravity nas opções</label>
      <label className="mt-3 block text-[10px] text-muted">Workspace do projeto (opcional; recupera memórias específicas)<input value={projectPath} onChange={e=>setProjectPath(e.target.value)} placeholder="C:\Projetos\meu-app" className={input}/></label>
      <button disabled={busy || !prompt.trim()} onClick={()=>void analyze()} className="mt-4 rounded-lg bg-accent px-4 py-2.5 text-xs font-semibold text-zinc-950 disabled:opacity-40">{busy ? "Analisando..." : "Analisar e recomendar"}</button>
      {error && <p className="mt-3 text-xs text-rose-300">{error}</p>}
      {route && <div className="mt-5 space-y-4 border-t border-line pt-5">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-[10px] uppercase tracking-wider text-muted">Provedor recomendado</p><h3 className="mt-1 text-xl font-semibold">{names[route.provider]}</h3></div><div className="rounded-lg border border-line px-3 py-2 text-right"><p className="text-[10px] text-muted">Confiança heurística</p><p className="text-lg font-semibold">{Math.round(route.confidence*100)}%</p></div></div>
        <div className="grid grid-cols-3 gap-2 text-center">{[["Tipo",route.task_kind],["Complexidade",route.complexity],["Effort",route.effort]].map(([label,value])=><div key={label} className="rounded-lg bg-canvas p-3"><p className="text-[10px] text-muted">{label}</p><p className="mt-1 text-xs font-medium">{value}</p></div>)}</div>
        <div><p className="mb-2 text-xs font-semibold">Por que foi escolhido</p>{route.rationale.map((reason,i)=><p key={i} className="mb-1 text-xs text-slate-400">• {reason}</p>)}</div>
        <div><p className="mb-2 text-xs font-semibold">Pontuação dos candidatos</p>{route.candidates.map(candidate=><div key={candidate.provider} className="mb-2"><div className="mb-1 flex justify-between text-[10px]"><span>{names[candidate.provider]}</span><span>{candidate.score}/100</span></div><div className="h-1.5 overflow-hidden rounded-full bg-canvas"><div className="h-full rounded-full bg-accent" style={{width:`${candidate.score}%`}}/></div></div>)}</div>
        <p className="text-[10px] text-muted">Modelo: padrão configurado no CLI local. Fallback sugerido: {route.fallback_order.map(p=>names[p]).join(" → ") || "nenhum"}.</p>
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-[10px] text-amber-200"><ShieldCheck size={15}/>A recomendação não executa nada. Confirme provedor, diretório e permissões antes de iniciar.</div>
      </div>}
    </section>
    <aside className={panel}>
      <div className="mb-3 flex items-center gap-2"><GitBranch size={16} className="text-accent"/><h2 className="text-xs font-semibold">Delegação sugerida</h2></div>
      {!blueprint ? <p className="text-xs leading-5 text-muted">Após analisar uma tarefa, será gerado um fluxo consultivo de planejamento, implementação e revisão cruzada.</p> : <><p className="mb-4 text-xs text-slate-300">{blueprint.title}</p>{blueprint.steps.map((step,index)=><div key={step.id} className="relative mb-3 rounded-lg border border-line bg-canvas p-3"><div className="mb-1 flex items-center justify-between"><span className="text-[10px] font-semibold">{index+1}. {step.role}</span><span className="text-[9px] text-accent">{names[step.suggested_provider]} · {step.effort}</span></div><p className="text-[10px] leading-4 text-muted">{step.objective}</p>{step.depends_on.length>0&&<p className="mt-2 flex items-center gap-1 text-[9px] text-slate-500"><ArrowRight size={10}/>Após: {step.depends_on.join(", ")}</p>}</div>)}<button disabled={busy} onClick={()=>void saveAsWorkflow()} className="mt-2 w-full rounded-lg border border-line px-3 py-2 text-xs font-medium text-slate-200 hover:border-accent disabled:opacity-40">Salvar como Workflow</button>{savedWorkflow && <p className="mt-2 text-[10px] text-emerald-300">{savedWorkflow}</p>}<p className="mt-3 text-[10px] leading-4 text-amber-200">{blueprint.note}</p></>}
    </aside>
  </div>;
}
