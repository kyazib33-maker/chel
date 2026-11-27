import { useEffect, useState } from "react";
import { BrainCircuit, Calculator, RefreshCw, Save, Search, Trash2 } from "lucide-react";
import {
  desktopBridgeAvailable, configureModelPricing, deleteProjectMemory, estimateModelCost, listModelPricing,
  rememberProjectMemory, searchProjectMemory,
  type MemoryEntry, type MemoryKind, type ModelPricing, type ProviderId,
} from "../../lib/tauri";

const providers: Array<{ id: ProviderId; name: string }> = [
  { id: "claude_code", name: "Claude Code" }, { id: "codex", name: "Codex" }, { id: "antigravity", name: "Antigravity" },
];
const input = "mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-2 text-xs text-zinc-100 outline-none focus:border-accent";

export default function IntelligenceConsole() {
  const [projectPath, setProjectPath] = useState("");
  const [kind, setKind] = useState<MemoryKind>("decision");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [query, setQuery] = useState("");
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [pricing, setPricing] = useState<ModelPricing[]>([]);
  const [provider, setProvider] = useState<ProviderId>("claude_code");
  const [model, setModel] = useState("");
  const [inputRate, setInputRate] = useState("0");
  const [outputRate, setOutputRate] = useState("0");
  const [inputTokens, setInputTokens] = useState("100000");
  const [outputTokens, setOutputTokens] = useState("30000");
  const [maxBudgetUsd, setMaxBudgetUsd] = useState("");
  const [estimate, setEstimate] = useState<number | null>(null);
  const [budgetAssessment, setBudgetAssessment] = useState<{ allowed: boolean; reasons: string[] } | null>(null);
  const [disclaimer, setDisclaimer] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    if (!desktopBridgeAvailable) return;
    setBusy(true); setMessage("");
    try {
      const [items, prices] = await Promise.all([searchProjectMemory(query, projectPath.trim() || null), listModelPricing()]);
      setMemories(items); setPricing(prices);
    } catch (error) { setMessage(String(error)); } finally { setBusy(false); }
  }
  useEffect(() => { void refresh(); }, []);

  async function saveMemory() {
    if (!title.trim() || !content.trim()) return;
    setBusy(true); setMessage("");
    try {
      await rememberProjectMemory({ projectPath: projectPath.trim() || null, kind, title: title.trim(), content: content.trim(), tags: tags.split(",").map((v) => v.trim()).filter(Boolean), importance: 5 });
      setTitle(""); setContent(""); setTags(""); setMessage("Memória salva."); await refresh();
    } catch (error) { setMessage(String(error)); } finally { setBusy(false); }
  }

  async function savePricing() {
    if (!model.trim()) return;
    setBusy(true); setMessage("");
    try {
      const data = await configureModelPricing(provider, model.trim(), Number(inputRate), Number(outputRate));
      setPricing(data); setMessage("Preço configurado. A estimativa continuará marcada como aproximada.");
    } catch (error) { setMessage(String(error)); } finally { setBusy(false); }
  }

  async function calculate() {
    setBusy(true); setMessage("");
    try {
      const budget = maxBudgetUsd.trim() ? { max_estimated_usd: Number(maxBudgetUsd) } : null;
      const response = await estimateModelCost(provider, model.trim(), Number(inputTokens), Number(outputTokens), budget);
      setEstimate(response.estimate?.estimated_usd ?? null);
      setDisclaimer(response.estimate?.disclaimer ?? "Sem preço exato configurado para este provedor/modelo.");
      setBudgetAssessment(response.budget);
    } catch (error) { setMessage(String(error)); } finally { setBusy(false); }
  }

  async function removeMemory(id: string) {
    setBusy(true); setMessage("");
    try { await deleteProjectMemory(id); setMessage("Memória removida."); await refresh(); }
    catch (error) { setMessage(String(error)); } finally { setBusy(false); }
  }

  return <section className="space-y-5">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-[10px] tracking-[0.2em] text-accent">OPERATIONAL INTELLIGENCE</p><h1 className="mt-1 text-xl font-semibold">Memória, custos e governança</h1><p className="mt-1 text-xs text-muted">Contexto persistente por projeto, preços configuráveis e estimativas auditáveis.</p></div><button onClick={() => void refresh()} disabled={busy || !desktopBridgeAvailable} className="flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-xs"><RefreshCw size={13} className={busy ? "animate-spin" : ""}/> Atualizar</button></header>
    {!desktopBridgeAvailable ? <p className="rounded-xl border border-line bg-panel p-4 text-xs text-amber-300">Abra pelo Desktop Tauri para acessar os dados locais.</p> : null}
    {message ? <p className="rounded-lg border border-line bg-panel p-3 text-xs text-slate-300">{message}</p> : null}
    <div className="grid gap-5 xl:grid-cols-2">
      <article className="rounded-xl border border-line bg-panel p-5">
        <div className="mb-4 flex items-center gap-2"><BrainCircuit size={16} className="text-accent"/><h2 className="text-sm font-semibold">Memória compartilhada</h2></div>
        <label className="block text-[10px] text-muted">Projeto (caminho absoluto; vazio = global)<input className={input} value={projectPath} onChange={(e) => setProjectPath(e.target.value)} placeholder="C:\Projetos\meu-app"/></label>
        <div className="mt-3 grid grid-cols-2 gap-3"><label className="text-[10px] text-muted">Tipo<select className={input} value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)}><option value="decision">Decisão</option><option value="fact">Fato</option><option value="constraint">Restrição</option><option value="pattern">Padrão</option><option value="outcome">Resultado</option></select></label><label className="text-[10px] text-muted">Tags<input className={input} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="rust, arquitetura"/></label></div>
        <label className="mt-3 block text-[10px] text-muted">Título<input className={input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Decisão técnica"/></label>
        <label className="mt-3 block text-[10px] text-muted">Conteúdo<textarea className={`${input} min-h-24`} value={content} onChange={(e) => setContent(e.target.value)} placeholder="Registre apenas fatos e decisões não sensíveis."/></label>
        <button onClick={() => void saveMemory()} disabled={busy || !title.trim() || !content.trim()} className="mt-3 flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-zinc-950 disabled:opacity-40"><Save size={13}/> Salvar memória</button>
        <div className="mt-5 border-t border-line pt-4"><div className="flex gap-2"><input className={input} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Pesquisar memórias"/><button onClick={() => void refresh()} className="mt-1 rounded-lg border border-line px-3"><Search size={13}/></button></div>
          <div className="mt-3 max-h-64 space-y-2 overflow-auto">{memories.map((item) => <div key={item.id} className="rounded-lg border border-line bg-canvas p-3"><div className="flex justify-between gap-2"><div><span className="text-[10px] font-semibold">{item.title}</span><span className="ml-2 text-[9px] text-muted">{item.kind}</span></div><button disabled={busy} onClick={() => void removeMemory(item.id)} title="Remover memória" className="text-muted hover:text-rose-300"><Trash2 size={12}/></button></div><p className="mt-1 whitespace-pre-wrap text-[10px] text-slate-400">{item.content}</p><p className="mt-2 text-[9px] text-muted">{item.scope} · {item.tags.join(", ")}</p></div>)}{memories.length === 0 ? <p className="text-[10px] text-muted">Nenhuma memória encontrada.</p> : null}</div>
        </div>
      </article>
      <article className="rounded-xl border border-line bg-panel p-5">
        <div className="mb-4 flex items-center gap-2"><Calculator size={16} className="text-accent"/><h2 className="text-sm font-semibold">Estimativa de custos</h2></div>
        <p className="mb-3 text-[10px] text-muted">Insira os preços do modelo conforme seu contrato ou tabela vigente. Não há tarifação inventada pelo aplicativo.</p>
        <div className="grid grid-cols-2 gap-3"><label className="text-[10px] text-muted">Provedor<select className={input} value={provider} onChange={(e) => setProvider(e.target.value as ProviderId)}>{providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label className="text-[10px] text-muted">Modelo<input className={input} value={model} onChange={(e) => setModel(e.target.value)} placeholder="ID exato do modelo"/></label></div>
        <div className="mt-3 grid grid-cols-2 gap-3"><label className="text-[10px] text-muted">USD / 1M tokens de entrada<input type="number" min="0" step="0.0001" className={input} value={inputRate} onChange={(e) => setInputRate(e.target.value)}/></label><label className="text-[10px] text-muted">USD / 1M tokens de saída<input type="number" min="0" step="0.0001" className={input} value={outputRate} onChange={(e) => setOutputRate(e.target.value)}/></label></div>
        <button onClick={() => void savePricing()} disabled={busy || !model.trim()} className="mt-3 rounded-lg border border-line px-3 py-2 text-xs">Salvar preço informado</button>
        <div className="mt-5 grid grid-cols-2 gap-3"><label className="text-[10px] text-muted">Tokens de entrada<input type="number" min="0" className={input} value={inputTokens} onChange={(e) => setInputTokens(e.target.value)}/></label><label className="text-[10px] text-muted">Tokens de saída<input type="number" min="0" className={input} value={outputTokens} onChange={(e) => setOutputTokens(e.target.value)}/></label></div>
        <label className="mt-3 block text-[10px] text-muted">Teto estimado em USD (opcional)<input type="number" min="0" step="0.01" className={input} value={maxBudgetUsd} onChange={(e) => setMaxBudgetUsd(e.target.value)} placeholder="Ex.: 5.00"/></label>
        <button onClick={() => void calculate()} disabled={busy || !model.trim()} className="mt-3 flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-zinc-950"><Calculator size={13}/> Calcular estimativa</button>
        {estimate !== null ? <div className="mt-4 rounded-lg border border-line bg-canvas p-3"><p className="text-[10px] text-muted">Custo estimado</p><p className="mt-1 text-2xl font-semibold">US$ {estimate.toFixed(6)}</p><p className="mt-2 text-[9px] text-muted">{disclaimer}</p>{budgetAssessment ? <p className={`mt-2 text-[10px] ${budgetAssessment.allowed ? "text-emerald-300" : "text-amber-300"}`}>{budgetAssessment.allowed ? "Dentro do teto informado." : budgetAssessment.reasons.join("; ")}</p> : null}</div> : <p className="mt-4 text-[10px] text-muted">Sem preço configurado para este modelo, nenhuma estimativa será apresentada.</p>}
        <div className="mt-5 border-t border-line pt-4"><p className="text-[10px] font-semibold">Modelos configurados ({pricing.length})</p><div className="mt-2 space-y-1">{pricing.map((item) => <p key={`${item.provider}:${item.model}`} className="text-[9px] text-muted">{item.provider} / {item.model}: {item.input_usd_per_million_tokens} entrada · {item.output_usd_per_million_tokens} saída (USD/1M)</p>)}</div></div>
      </article>
    </div>
  </section>;
}
