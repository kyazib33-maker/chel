import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, FolderGit2, GitBranch, Plus, RefreshCw, Trash2 } from "lucide-react";
import { desktopBridgeAvailable, createWorktree, listWorktrees, removeWorktree, type WorktreeInfo } from "../../lib/tauri";

export default function WorktreePanel() {
  const [repository, setRepository] = useState("");
  const [name, setName] = useState("Backend implementation");
  const [branch, setBranch] = useState("agent/backend-implementation");
  const [baseRef, setBaseRef] = useState("HEAD");
  const [items, setItems] = useState<WorktreeInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    if (!desktopBridgeAvailable) return;
    try { setItems(await listWorktrees()); }
    catch (reason) { setError(String(reason)); }
  }

  useEffect(() => { void refresh(); }, []);

  async function create() {
    if (!repository.trim() || !name.trim() || !branch.trim()) return;
    setBusy(true); setError(null);
    try {
      await createWorktree({ repository, name, branch_name: branch, base_ref: baseRef.trim() || "HEAD" });
      await refresh();
      setName("Nova tarefa"); setBranch(`agent/task-${Date.now().toString().slice(-5)}`);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  async function remove(item: WorktreeInfo) {
    const force = !item.clean;
    const prompt = !item.present
      ? `O diretório de ${item.name} não existe mais. Limpar o registro e metadados obsoletos do Git?`
      : force
        ? `Este worktree possui ${item.modified_files} arquivo(s) modificado(s), ${item.untracked_files} não rastreado(s) e ${item.staged_files} staged. Remover forçadamente e descartar essas alterações?`
        : `Remover o worktree ${item.name}?`;
    if (!window.confirm(prompt)) return;
    setBusy(true); setError(null);
    try { await removeWorktree(item.id, force); await refresh(); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  const inputClass = "w-full rounded-lg border border-line bg-canvas px-3 py-2.5 text-xs text-zinc-100 outline-none focus:border-accent";

  return (
    <div className="space-y-5">
      <div><p className="text-[11px] uppercase tracking-[0.2em] text-muted">Git isolation</p><h1 className="mt-1 text-2xl font-semibold">Worktree Manager</h1><p className="mt-1 text-xs text-muted">Crie diretórios e branches isolados para agentes que trabalham no mesmo repositório.</p></div>
      <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
        <section className="h-fit rounded-2xl border border-line bg-panel p-5">
          <div className="mb-4 flex items-center gap-2"><Plus size={16} className="text-accent" /><h2 className="text-sm font-semibold">Criar worktree</h2></div>
          <div className="space-y-3">
            <Field label="Caminho do repositório Git"><input className={inputClass} value={repository} onChange={(event) => setRepository(event.target.value)} placeholder="C:\Projetos\meu-repositorio" /></Field>
            <Field label="Nome da tarefa"><input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} /></Field>
            <Field label="Nova branch"><input className={inputClass} value={branch} onChange={(event) => setBranch(event.target.value)} /></Field>
            <Field label="Referência base"><input className={inputClass} value={baseRef} onChange={(event) => setBaseRef(event.target.value)} placeholder="HEAD, main, develop..." /></Field>
            <button disabled={!desktopBridgeAvailable || busy || !repository.trim() || !branch.trim() || !name.trim()} onClick={() => void create()} className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-3 text-xs font-semibold text-zinc-950 disabled:cursor-not-allowed disabled:opacity-40"><FolderGit2 size={15} />{busy ? "Processando..." : "Criar worktree"}</button>
            {!desktopBridgeAvailable && <p className="text-[10px] text-amber-300">A criação de worktrees requer o Host Tauri.</p>}
          </div>
          <div className="mt-4 flex gap-2 rounded-lg border border-slate-700 bg-slate-900/50 p-3"><AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-300" /><p className="text-[10px] leading-4 text-slate-400">O aplicativo só remove worktrees registrados por ele. Alterações locais impedem remoção normal; o descarte forçado exige confirmação explícita.</p></div>
          {error && <p className="mt-3 break-words text-xs text-rose-300">{error}</p>}
        </section>

        <section className="rounded-2xl border border-line bg-panel">
          <div className="flex items-center justify-between border-b border-line px-5 py-4"><div><h2 className="text-sm font-semibold">Worktrees gerenciados</h2><p className="mt-1 text-[10px] text-muted">{items.length} workspace(s) registrados</p></div><button onClick={() => void refresh()} className="rounded-lg border border-line p-2 text-muted hover:bg-canvas" title="Atualizar"><RefreshCw size={14} /></button></div>
          {items.length === 0 ? <div className="p-12 text-center"><GitBranch size={24} className="mx-auto text-muted" /><p className="mt-3 text-sm text-slate-300">Nenhum worktree gerenciado</p><p className="mt-1 text-xs text-muted">Crie um workspace isolado para iniciar uma linha de trabalho paralela.</p></div> : <div className="divide-y divide-line">{items.map((item) => <article key={item.id} className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-medium">{item.name}</h3><span className={`rounded-full border px-2 py-0.5 text-[10px] ${item.clean ? "border-emerald-500/30 text-emerald-300" : "border-amber-500/30 text-amber-300"}`}>{item.clean ? "Limpo" : "Com alterações"}</span>{!item.present && <span className="text-[10px] text-rose-300">Diretório ausente</span>}</div><p className="mt-1 flex items-center gap-1.5 text-xs text-cyan-200"><GitBranch size={12} />{item.branch_name} <span className="text-slate-600">· base {item.base_ref}</span></p></div>
              <button disabled={busy} onClick={() => void remove(item)} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-[11px] text-slate-400 hover:border-rose-500/40 hover:text-rose-300 disabled:opacity-30"><Trash2 size={13} /> Remover</button></div>
            <p className="mt-3 break-all font-mono text-[10px] text-slate-500">{item.path}</p>
            <div className="mt-3 flex flex-wrap gap-4 text-[10px] text-slate-500"><span>{item.modified_files} modificados</span><span>{item.staged_files} staged</span><span>{item.untracked_files} não rastreados</span></div>
          </article>)}</div>}
        </section>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block space-y-1.5"><span className="block text-[10px] text-muted">{label}</span>{children}</label>;
}
