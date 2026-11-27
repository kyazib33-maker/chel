import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Clock3, CheckCircle2, XCircle, CircleStop, Activity } from "lucide-react";
import {
  desktopBridgeAvailable, listWorkflowRuns, listWorkflowExecutions, listWorkflowCheckpoints, cancelWorkflow, assessCheckpointResume, resumeWorkflow,
  onWorkflowProgress, onWorkflowFinished,
  type WorkflowRunResult, type WorkflowExecutionSnapshot, type WorkflowCheckpoint,
} from "../../lib/tauri";

export default function WorkflowRunHistory() {
  const [runs, setRuns] = useState<WorkflowRunResult[]>([]);
  const [active, setActive] = useState<WorkflowExecutionSnapshot[]>([]);
  const [checkpoints, setCheckpoints] = useState<WorkflowCheckpoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    if (!desktopBridgeAvailable) return;
    setBusy(true); setError(null);
    try {
      const [history, executions, savedCheckpoints] = await Promise.all([listWorkflowRuns(50), listWorkflowExecutions(), listWorkflowCheckpoints()]);
      setRuns(history); setActive(executions.filter((item) => ["queued", "running"].includes(item.status))); setCheckpoints(savedCheckpoints);
    } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  }, []);
  useEffect(() => {
    void refresh();
    if (!desktopBridgeAvailable) return;
    let offProgress: (() => void) | undefined;
    let offFinished: (() => void) | undefined;
    void onWorkflowProgress(() => { void refresh(); }).then((off) => { offProgress = off; });
    void onWorkflowFinished(() => { void refresh(); }).then((off) => { offFinished = off; });
    const interval = window.setInterval(() => { void refresh(); }, 2500);
    return () => { window.clearInterval(interval); offProgress?.(); offFinished?.(); };
  }, [refresh]);
  const stop = async (id: string) => { try { await cancelWorkflow(id); await refresh(); } catch (reason) { setError(String(reason)); } };
  const resume = async (id: string) => {
    try {
      const assessment = await assessCheckpointResume(id);
      if (!assessment.can_resume) { setError(assessment.warnings.join(" ") || "Checkpoint não pode ser retomado com segurança."); return; }
      const caveats = assessment.warnings.length ? `\n\nAtenção:\n${assessment.warnings.join("\n")}` : "";
      const accepted = window.confirm(`Workspace verificado. ${assessment.successful_nodes.length} agentes serão preservados. Agentes sem resultado poderão ser executados novamente.${caveats}\n\nContinuar?`);
      if (!accepted) return;
      const retryFailed = assessment.retryable_nodes.length > 0 && window.confirm(`Há ${assessment.retryable_nodes.length} agentes com falha ou resultado incompleto. Deseja tentar novamente esses agentes?`);
      await resumeWorkflow(id, retryFailed, true);
      await refresh();
    } catch (reason) { setError(String(reason)); }
  };
  return <section className="space-y-4">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-[10px] tracking-[0.2em] text-accent">WORKFLOW TELEMETRY</p><h1 className="mt-1 text-xl font-semibold">Execuções</h1><p className="mt-1 text-xs text-muted">Progresso, eventos e histórico persistente de workflows.</p></div><button onClick={() => void refresh()} disabled={busy || !desktopBridgeAvailable} className="flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-xs"><RefreshCw size={13} className={busy ? "animate-spin" : ""}/> Atualizar</button></header>
    {!desktopBridgeAvailable ? <div className="rounded-xl border border-line bg-panel p-5 text-xs text-amber-300">Abra o aplicativo Desktop para consultar as execuções locais.</div> : null}
    {error ? <p className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-300">{error}</p> : null}
    <div className="space-y-3"><div className="flex items-center gap-2 text-xs font-semibold"><Activity size={14} className="text-accent"/> Em andamento ({active.length})</div>
      {active.length === 0 ? <div className="rounded-xl border border-line bg-panel p-4 text-xs text-muted">Nenhum workflow em execução.</div> : active.map((item) => <article key={item.run_id} className="rounded-xl border border-accent/30 bg-panel p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><div><span className="text-xs font-semibold">{item.status === "queued" ? "Na fila" : "Executando"}</span><p className="mt-1 font-mono text-[9px] text-muted">{item.run_id}</p></div><button onClick={() => void stop(item.run_id)} className="flex items-center gap-1 rounded-lg border border-rose-500/30 px-2 py-1.5 text-[10px] text-rose-300"><CircleStop size={12}/> Cancelar workflow</button></div>
        <div className="mt-3 flex flex-wrap gap-2">{item.events.slice(-8).map((event, index) => <span key={`${event.event}-${event.node_id}-${index}`} className="rounded-md bg-canvas px-2 py-1 text-[9px] text-slate-300">{event.node_id ?? "Workflow"}: {event.event} ({event.status})</span>)}</div>
      </article>)}
    </div>
    <div className="space-y-3"><div className="text-xs font-semibold">Checkpoints recuperáveis ({checkpoints.filter((item) => ["interrupted", "cancelled", "failed"].includes(item.status)).length})</div>
      {checkpoints.filter((item) => ["interrupted", "cancelled", "failed"].includes(item.status)).map((item) => <article key={item.run_id} className="rounded-xl border border-amber-500/20 bg-panel p-4">
        <div className="flex items-center justify-between gap-2"><span className="text-xs font-semibold">{item.workflow.name}</span><span className="rounded-md bg-amber-500/10 px-2 py-1 text-[9px] text-amber-300">{item.status}</span></div>
        <p className="mt-1 font-mono text-[9px] text-muted">{item.run_id} · {item.completed_nodes.length} nós com resultados preservados</p>
        {item.recovery_note ? <p className="mt-2 text-[10px] text-amber-200">{item.recovery_note}</p> : null}
        <p className="mt-2 text-[9px] text-muted">Workspace: {item.repository}. O Host compara o estado Git atual ao fingerprint salvo. Agentes sem resultado exigem confirmação antes de serem reexecutados.</p>
        <button onClick={() => void resume(item.run_id)} className="mt-3 rounded-lg border border-amber-500/30 px-3 py-2 text-[10px] text-amber-200 hover:bg-amber-500/10">Verificar integridade e retomar</button>
      </article>)}
      {checkpoints.every((item) => !["interrupted", "cancelled", "failed"].includes(item.status)) ? <div className="rounded-xl border border-line bg-panel p-3 text-[10px] text-muted">Nenhum checkpoint pendente de recuperação.</div> : null}
    </div>
    <div className="space-y-3"><div className="text-xs font-semibold">Histórico concluído</div>
      {desktopBridgeAvailable && !runs.length && !busy ? <div className="rounded-xl border border-line bg-panel p-8 text-center text-xs text-muted">Nenhuma execução registrada ainda.</div> : null}
      {runs.map((run) => <article key={run.run_id} className="rounded-xl border border-line bg-panel p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2">{run.status === "succeeded" ? <CheckCircle2 size={15} className="text-emerald-400"/> : <XCircle size={15} className="text-rose-400"/>}<span className="text-xs font-semibold">{run.status === "succeeded" ? "Concluído" : run.status}</span><span className="text-[10px] text-muted">{run.nodes.length} agentes</span></div><span className="flex items-center gap-1 text-[10px] text-muted"><Clock3 size={12}/>{new Date(run.started_at).toLocaleString()}</span></div>
        <p className="mt-2 break-all font-mono text-[9px] text-muted">Run {run.run_id} · Workflow {run.workflow_id}</p>
        <div className="mt-3 grid gap-2 md:grid-cols-2">{run.nodes.map((node) => <div key={node.node_id} className="rounded-lg border border-line bg-canvas p-3"><div className="flex items-center justify-between gap-2"><span className="text-[11px] font-medium">{node.node_id}</span><span className={`text-[9px] ${node.status === "succeeded" ? "text-emerald-400" : "text-rose-300"}`}>{node.status}</span></div>{node.error ? <p className="mt-2 text-[10px] text-rose-300">{node.error}</p> : null}{node.output ? <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words text-[9px] text-slate-400">{node.output}</pre> : null}</div>)}</div>
        <p className="mt-3 text-right text-[9px] text-muted">Finalizada em {new Date(run.finished_at).toLocaleString()}</p>
      </article>)}
    </div>
  </section>;
}
