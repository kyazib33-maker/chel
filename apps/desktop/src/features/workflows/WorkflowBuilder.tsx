import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  addEdge, Background, Controls, Handle, MarkerType, MiniMap, Position,
  ReactFlow, useEdgesState, useNodesState,
  type Connection, type Edge, type Node, type NodeProps,
} from "@xyflow/react";
import { AlertCircle, Check, Copy, GitBranch, Plus, Save, Trash2, Workflow } from "lucide-react";
import "@xyflow/react/dist/style.css";
import {
  desktopBridgeAvailable, listWorkflows, startWorkflow, saveWorkflow, validateWorkflow,
  type AgentNodeDefinition, type ContextMode, type ProviderId, type WorktreeMode,
  type WorkflowDefinition, type WorkflowValidation,
} from "../../lib/tauri";

type AgentNodeData = {
  name: string;
  role: string;
  prompt: string;
  provider: ProviderId;
  model: string;
  effort: string;
  context_mode: ContextMode;
  worktree_mode: WorktreeMode;
};
type AgentCanvasNode = Node<AgentNodeData, "agent">;
type ContextEdge = Edge<{ pass_context: boolean }>;

const providerNames: Record<ProviderId, string> = {
  claude_code: "Claude Code",
  codex: "Codex CLI",
  antigravity: "Antigravity",
};

const AgentNodeView = memo(({ data, selected }: NodeProps<AgentCanvasNode>) => (
  <div className={`min-w-[220px] rounded-xl border bg-[#121821] shadow-xl ${selected ? "border-cyan-300 shadow-cyan-950/50" : "border-slate-700"}`}>
    <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !border-2 !border-slate-950 !bg-cyan-300" />
    <div className="flex items-center gap-2 border-b border-slate-700/80 px-3 py-2.5">
      <div className="rounded-md bg-cyan-300/10 p-1.5 text-cyan-200"><Workflow size={14} /></div>
      <div className="min-w-0"><p className="truncate text-xs font-semibold text-slate-100">{data.name}</p><p className="text-[10px] text-slate-500">{data.role}</p></div>
    </div>
    <div className="space-y-1 px-3 py-2.5">
      <p className="text-[10px] text-cyan-200">{providerNames[data.provider]}</p>
      <p className="truncate text-[10px] text-slate-400">{data.model || "Modelo padrão"} · {data.effort || "medium"}</p>
      <div className="flex items-center gap-1 text-[9px] text-slate-500"><GitBranch size={10} /> {data.worktree_mode === "isolated" ? "Worktree isolado" : data.worktree_mode === "shared" ? "Workspace compartilhado" : "Herdar workspace"}</div>
    </div>
    <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !border-2 !border-slate-950 !bg-cyan-300" />
  </div>
));
AgentNodeView.displayName = "AgentNodeView";
const nodeTypes = { agent: AgentNodeView };

function makeNode(id: string, index: number, data?: Partial<AgentNodeData>): AgentCanvasNode {
  return {
    id,
    type: "agent",
    position: { x: 80 + (index % 2) * 340, y: 70 + Math.floor(index / 2) * 190 },
    data: {
      name: data?.name ?? `Agente ${index + 1}`,
      role: data?.role ?? "Implementador",
      prompt: data?.prompt ?? "Execute a tarefa recebida. Preserve as decisões e restrições do projeto.",
      provider: data?.provider ?? "claude_code",
      model: data?.model ?? "",
      effort: data?.effort ?? "medium",
      context_mode: data?.context_mode ?? "summary",
      worktree_mode: data?.worktree_mode ?? "isolated",
    },
  };
}

function makeStarter(): { nodes: AgentCanvasNode[]; edges: ContextEdge[] } {
  return {
    nodes: [
      makeNode("architect", 0, { name: "Arquiteto", role: "Planejamento", provider: "claude_code", model: "", effort: "high" }),
      makeNode("backend", 1, { name: "Backend Dev", role: "Implementação API", provider: "codex", model: "", effort: "medium" }),
      makeNode("frontend", 2, { name: "Frontend Dev", role: "Implementação UI", provider: "antigravity", effort: "medium" }),
      makeNode("reviewer", 3, { name: "Code Reviewer", role: "Revisão", provider: "claude_code", model: "", effort: "medium" }),
    ],
    edges: [
      { id: "e-architect-backend", source: "architect", target: "backend", type: "smoothstep", animated: true, markerEnd: { type: MarkerType.ArrowClosed }, data: { pass_context: true }, label: "Resumo + plano" },
      { id: "e-architect-frontend", source: "architect", target: "frontend", type: "smoothstep", animated: true, markerEnd: { type: MarkerType.ArrowClosed }, data: { pass_context: true }, label: "Resumo + plano" },
      { id: "e-backend-review", source: "backend", target: "reviewer", type: "smoothstep", markerEnd: { type: MarkerType.ArrowClosed }, data: { pass_context: true } },
      { id: "e-frontend-review", source: "frontend", target: "reviewer", type: "smoothstep", markerEnd: { type: MarkerType.ArrowClosed }, data: { pass_context: true } },
    ],
  };
}

function makeDefinition(id: string, name: string, nodes: AgentCanvasNode[], edges: ContextEdge[], createdAt: string): WorkflowDefinition {
  const agentNodes: AgentNodeDefinition[] = nodes.map((node) => ({
    id: node.id,
    name: node.data.name,
    role: node.data.role,
    prompt: node.data.prompt,
    provider: node.data.provider,
    model: node.data.model.trim() || null,
    effort: node.data.effort || null,
    context_mode: node.data.context_mode,
    worktree_mode: node.data.worktree_mode,
    position: node.position,
  }));
  return {
    id, name, nodes: agentNodes,
    edges: edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, pass_context: edge.data?.pass_context ?? true })),
    created_at: createdAt,
    updated_at: new Date().toISOString(),
  };
}

function fromDefinition(definition: WorkflowDefinition) {
  return {
    nodes: definition.nodes.map((node) => makeNode(node.id, 0, {
      name: node.name, role: node.role, prompt: node.prompt, provider: node.provider,
      model: node.model ?? "", effort: node.effort ?? "medium",
      context_mode: node.context_mode, worktree_mode: node.worktree_mode,
    })).map((node, index) => {
      const saved = definition.nodes.find((candidate) => candidate.id === node.id);
      return { ...node, position: saved?.position ?? { x: 80 + (index % 2) * 340, y: 80 + Math.floor(index / 2) * 180 } };
    }),
    edges: definition.edges.map((edge) => ({
      id: edge.id, source: edge.source, target: edge.target, type: "smoothstep",
      markerEnd: { type: MarkerType.ArrowClosed }, data: { pass_context: edge.pass_context },
    })) as ContextEdge[],
  };
}

function validateLocally(definition: WorkflowDefinition): WorkflowValidation {
  const ids = new Set(definition.nodes.map((node) => node.id));
  const errors: string[] = [];
  if (!definition.name.trim()) errors.push("Informe um nome para o fluxo.");
  if (!definition.nodes.length) errors.push("Adicione pelo menos um agente.");
  for (const edge of definition.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) errors.push(`Conexão ${edge.id} aponta para um bloco inexistente.`);
  }
  const incoming = new Map(definition.nodes.map((node) => [node.id, 0]));
  const adjacency = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const edge of definition.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
    if (edge.source === edge.target) { errors.push(`O bloco ${edge.source} não pode se conectar a si próprio.`); continue; }
    const key = `${edge.source}->${edge.target}`;
    if (seen.has(key)) { errors.push(`Conexão duplicada: ${edge.source} → ${edge.target}.`); continue; }
    seen.add(key);
    adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge.target]);
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
  }
  const queue = [...incoming.entries()].filter(([, count]) => count === 0).map(([id]) => id);
  const levels: string[][] = [];
  let visited = 0;
  while (queue.length) {
    const level = queue.splice(0, queue.length);
    levels.push(level);
    for (const id of level) {
      visited += 1;
      for (const target of adjacency.get(id) ?? []) {
        const next = (incoming.get(target) ?? 0) - 1;
        incoming.set(target, next);
        if (next === 0) queue.push(target);
      }
    }
  }
  if (visited !== definition.nodes.length) errors.push("O fluxo contém um ciclo. Remova uma conexão para continuar.");
  return { valid: errors.length === 0, errors, execution_levels: errors.length ? [] : levels };
}

export default function WorkflowBuilder() {
  const starter = useMemo(makeStarter, []);
  const [nodes, setNodes, onNodesChange] = useNodesState<AgentCanvasNode>(starter.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<ContextEdge>(starter.edges);
  const [workflowId, setWorkflowId] = useState<string>(() => crypto.randomUUID());
  const [createdAt, setCreatedAt] = useState(() => new Date().toISOString());
  const [workflowName, setWorkflowName] = useState("Equipe de desenvolvimento");
  const [selectedId, setSelectedId] = useState<string | null>("architect");
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [validation, setValidation] = useState<WorkflowValidation | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [repositoryPath, setRepositoryPath] = useState("");
  const [initialPrompt, setInitialPrompt] = useState("");

  const selectedNode = nodes.find((node) => node.id === selectedId) ?? null;
  const onConnect = useCallback((connection: Connection) => {
    setEdges((current) => addEdge({
      ...connection, id: crypto.randomUUID(), type: "smoothstep", animated: true,
      markerEnd: { type: MarkerType.ArrowClosed }, data: { pass_context: true },
    }, current));
    setValidation(null);
  }, [setEdges]);

  useEffect(() => {
    if (!desktopBridgeAvailable) return;
    void listWorkflows().then(setWorkflows).catch((error: unknown) => setMessage(String(error)));
  }, []);

  function updateSelected(patch: Partial<AgentNodeData>) {
    if (!selectedId) return;
    setNodes((current) => current.map((node) => node.id === selectedId ? { ...node, data: { ...node.data, ...patch } } : node));
    setValidation(null);
  }

  function addAgent() {
    const id = `agent-${crypto.randomUUID().slice(0, 8)}`;
    const node = makeNode(id, nodes.length);
    setNodes((current) => [...current, node]);
    setSelectedId(id); setSelectedEdgeId(null);
    setValidation(null);
  }

  function newWorkflow() {
    const example = makeStarter();
    setNodes(example.nodes); setEdges(example.edges);
    setWorkflowId(crypto.randomUUID()); setCreatedAt(new Date().toISOString());
    setWorkflowName("Novo workflow"); setSelectedId("architect"); setSelectedEdgeId(null);
    setValidation(null); setMessage(null);
  }

  async function runValidation() {
    setBusy(true); setMessage(null);
    try {
      const definition = makeDefinition(workflowId, workflowName, nodes, edges, createdAt);
      const result = desktopBridgeAvailable ? await validateWorkflow(definition) : validateLocally(definition);
      setValidation(result);
      setMessage(result.valid ? `Grafo válido · ${result.execution_levels.length} etapa(s) de execução.` : "Corrija os problemas apontados antes de salvar.");
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  }

  async function persist() {
    setBusy(true); setMessage(null);
    try {
      const definition = makeDefinition(workflowId, workflowName, nodes, edges, createdAt);
      const result = desktopBridgeAvailable ? await saveWorkflow(definition) : definition;
      const valid = desktopBridgeAvailable ? { valid: true, errors: [], execution_levels: [] } : validateLocally(definition);
      if (!valid.valid) { setValidation(valid); setMessage(valid.errors.join(" ")); return; }
      setWorkflowId(result.id); setCreatedAt(result.created_at);
      if (desktopBridgeAvailable) setWorkflows(await listWorkflows());
      setMessage(desktopBridgeAvailable ? "Workflow salvo no armazenamento local do Host." : "Prévia criada. Abra no Desktop Tauri para persistir o template.");
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  }

  async function executeWorkflow() {
    if (!desktopBridgeAvailable) return;
    if (!repositoryPath.trim() || !initialPrompt.trim()) { setMessage("Informe o caminho absoluto do repositório e o objetivo da execução."); return; }
    setBusy(true); setMessage("Executando workflow. Os nós paralelos serão iniciados em conjunto; acompanhe o Task Board.");
    try {
      const definition = makeDefinition(workflowId, workflowName, nodes, edges, createdAt);
      const validationResult = await validateWorkflow(definition);
      setValidation(validationResult);
      if (!validationResult.valid) { setMessage(validationResult.errors.join(" ")); return; }
      const reviewNode = definition.nodes.some((node) => /review|revis/i.test(`${node.name} ${node.role}`));
      if (!reviewNode) { setMessage("A política de execução exige um agente dedicado de revisão. Adicione um nó com papel/nome Revisão ou Review."); return; }
      const approved = window.confirm(`Confirmar execução multiagente?\n\nAgentes: ${definition.nodes.length}\nWorktrees isolados conforme configuração de cada nó.\nLimite por agente: 60 minutos.\nLimite total: 180 minutos.\nSaída capturada: até 64 KiB por agente.\nRevisão dedicada obrigatória.\n\nA execução pode alterar arquivos nos worktrees e consumir sua cota dos provedores.`);
      if (!approved) { setMessage("Execução cancelada antes de iniciar os agentes."); return; }
      const saved = await saveWorkflow(definition);
      setWorkflowId(saved.id); setCreatedAt(saved.created_at); setWorkflows(await listWorkflows());
      const result = await startWorkflow(saved.id, repositoryPath.trim(), initialPrompt.trim(), {
        max_nodes: 12, max_node_runtime_seconds: 3600, max_total_runtime_seconds: 10800,
        max_output_bytes: 65536, require_review_node: true,
      });
      setMessage(`Workflow iniciado em segundo plano · ID ${result.run_id}. Acompanhe em Execuções.`);
    } catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  }

  function loadWorkflow(id: string) {
    const workflow = workflows.find((item) => item.id === id);
    if (!workflow) return;
    const mapped = fromDefinition(workflow);
    setNodes(mapped.nodes); setEdges(mapped.edges);
    setWorkflowId(workflow.id); setCreatedAt(workflow.created_at);
    setWorkflowName(workflow.name); setSelectedId(mapped.nodes[0]?.id ?? null); setSelectedEdgeId(null);
    setValidation(null); setMessage(`Template carregado: ${workflow.name}`);
  }

  const providerOptions: ProviderId[] = ["claude_code", "codex", "antigravity"];
  const inputClass = "w-full rounded-lg border border-slate-700 bg-[#0b1119] px-3 py-2 text-xs text-slate-100 outline-none focus:border-cyan-300";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><p className="text-[11px] uppercase tracking-[0.2em] text-slate-500">Node editor · Fan-out / Fan-in</p><h1 className="mt-1 text-2xl font-semibold">Workflow Builder</h1><p className="mt-1 text-xs text-slate-400">Desenhe equipes, configure cada CLI e defina como o contexto passa entre os agentes.</p></div>
        <div className="flex flex-wrap gap-2">
          <button onClick={newWorkflow} className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800">Novo fluxo</button>
          <button onClick={addAgent} className="flex items-center gap-2 rounded-lg border border-cyan-300/30 bg-cyan-300/10 px-3 py-2 text-xs text-cyan-100 hover:bg-cyan-300/15"><Plus size={14} /> Agente</button>
          <button onClick={() => void runValidation()} disabled={busy} className="flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800"><Check size={14} /> Validar</button>
          <button onClick={() => void persist()} disabled={busy} className="flex items-center gap-2 rounded-lg bg-cyan-300 px-3 py-2 text-xs font-semibold text-slate-950 hover:brightness-110"><Save size={14} /> Salvar template</button>
          {desktopBridgeAvailable && <button onClick={() => void executeWorkflow()} disabled={busy} className="rounded-lg bg-emerald-300 px-3 py-2 text-xs font-semibold text-slate-950 disabled:opacity-50">Executar workflow</button>}
        </div>
      </div>

      {desktopBridgeAvailable && <div className="grid gap-3 rounded-xl border border-slate-800 bg-[#101720] p-4 md:grid-cols-2"><Field label="Repositório Git / diretório de trabalho"><input value={repositoryPath} onChange={(e) => setRepositoryPath(e.target.value)} className={inputClass} placeholder="C:\Projetos\meu-repositorio" /></Field><Field label="Objetivo inicial"><textarea value={initialPrompt} onChange={(e) => setInitialPrompt(e.target.value)} className={`${inputClass} min-h-[42px]`} placeholder="Descreva o que a equipe deve entregar…" /></Field><p className="md:col-span-2 text-[10px] text-slate-500">Nós isolados criam Git Worktrees próprios. Worktrees permanecem registrados no gerenciador após a execução para inspeção e merge manual.</p></div>}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_310px]">
        <div className="overflow-hidden rounded-xl border border-slate-800 bg-[#0a1018]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
            <div className="flex min-w-[220px] flex-1 items-center gap-2"><Workflow size={15} className="text-cyan-200" /><input value={workflowName} onChange={(event) => setWorkflowName(event.target.value)} className="max-w-sm flex-1 border-b border-transparent bg-transparent text-sm font-medium outline-none focus:border-cyan-300" aria-label="Nome do workflow" /></div>
            <div className="flex items-center gap-2">
              {desktopBridgeAvailable && <select value="" onChange={(event) => loadWorkflow(event.target.value)} className="max-w-[190px] rounded-md border border-slate-700 bg-[#0b1119] px-2 py-1.5 text-[11px] text-slate-300"><option value="">Carregar template salvo…</option>{workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}</select>}
              <span className="text-[10px] text-slate-500">{nodes.length} nós · {edges.length} conexões</span>
            </div>
          </div>
          <div className="h-[620px] w-full">
            <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onNodeClick={(_, node) => { setSelectedId(node.id); setSelectedEdgeId(null); }} onEdgeClick={(_, edge) => { setSelectedId(null); setSelectedEdgeId(edge.id); }} onPaneClick={() => { setSelectedId(null); setSelectedEdgeId(null); }} fitView deleteKeyCode={["Backspace", "Delete"]} defaultEdgeOptions={{ type: "smoothstep", markerEnd: { type: MarkerType.ArrowClosed } }}>
              <Background color="#263342" gap={22} size={1} />
              <Controls />
              <MiniMap pannable zoomable nodeColor="#164e63" maskColor="rgba(5, 10, 16, 0.65)" />
            </ReactFlow>
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-slate-800 px-4 py-3 text-[10px] text-slate-500"><span>Arraste de uma saída para uma entrada para conectar.</span><span>Conexões representam dependências.</span><span>Agentes irmãos podem executar em paralelo.</span></div>
        </div>

        <aside className="space-y-4">
          <div className="rounded-xl border border-slate-800 bg-[#101720] p-4">
            <div className="mb-3 flex items-center justify-between"><h2 className="text-xs font-semibold">Configuração do bloco</h2>{selectedNode && <button onClick={() => { setNodes((current) => current.filter((node) => node.id !== selectedId)); setEdges((current) => current.filter((edge) => edge.source !== selectedId && edge.target !== selectedId)); setSelectedId(null); }} className="rounded-md p-1.5 text-slate-500 hover:bg-rose-500/10 hover:text-rose-300" title="Excluir bloco"><Trash2 size={14} /></button>}</div>
            {selectedEdgeId ? <EdgeInspector edge={edges.find((edge) => edge.id === selectedEdgeId) ?? null} onChange={(pass_context) => setEdges((current) => current.map((edge) => edge.id === selectedEdgeId ? { ...edge, data: { pass_context } } : edge))} onDelete={() => { setEdges((current) => current.filter((edge) => edge.id !== selectedEdgeId)); setSelectedEdgeId(null); }} /> : !selectedNode ? <p className="text-xs leading-5 text-slate-500">Selecione um bloco ou uma conexão no canvas para editar suas configurações.</p> : <div className="space-y-3">
              <Field label="Nome"><input className={inputClass} value={selectedNode.data.name} onChange={(event) => updateSelected({ name: event.target.value })} /></Field>
              <Field label="Papel"><input className={inputClass} value={selectedNode.data.role} onChange={(event) => updateSelected({ role: event.target.value })} placeholder="Arquiteto, Backend Dev, Reviewer…" /></Field>
              <Field label="CLI"><select className={inputClass} value={selectedNode.data.provider} onChange={(event) => updateSelected({ provider: event.target.value as ProviderId })}>{providerOptions.map((value) => <option key={value} value={value}>{providerNames[value]}</option>)}</select></Field>
              <Field label="Modelo"><input className={inputClass} value={selectedNode.data.model} onChange={(event) => updateSelected({ model: event.target.value })} placeholder="Modelo padrão do CLI" /></Field>
              <Field label="Effort"><select className={inputClass} value={selectedNode.data.effort} onChange={(event) => updateSelected({ effort: event.target.value })}>{(selectedNode.data.provider === "codex" ? ["low", "medium", "high", "xhigh"] : selectedNode.data.provider === "claude_code" ? ["low", "medium", "high", "max"] : ["low", "medium", "high"]).map((value) => <option key={value}>{value}</option>)}</select></Field>
              <Field label="System prompt / papel"><textarea className={`${inputClass} resize-y`} rows={5} value={selectedNode.data.prompt} onChange={(event) => updateSelected({ prompt: event.target.value })} /></Field>
              <Field label="Passagem de contexto"><select className={inputClass} value={selectedNode.data.context_mode} onChange={(event) => updateSelected({ context_mode: event.target.value as ContextMode })}><option value="none">Não enviar contexto anterior</option><option value="summary">Resumo do agente anterior</option><option value="full_output">Saída completa</option><option value="files_only">Referências de arquivos</option></select></Field>
              <Field label="Workspace"><select className={inputClass} value={selectedNode.data.worktree_mode} onChange={(event) => updateSelected({ worktree_mode: event.target.value as WorktreeMode })}><option value="isolated">Worktree isolado</option><option value="shared">Workspace compartilhado</option><option value="inherit">Herdar workspace anterior</option></select></Field>
            </div>}
          </div>

          <div className="rounded-xl border border-slate-800 bg-[#101720] p-4">
            <h2 className="mb-2 text-xs font-semibold">Validação e execução</h2>
            {validation ? <div className="space-y-2">{validation.valid ? <p className="flex items-center gap-2 text-xs text-emerald-300"><Check size={14} /> Grafo válido</p> : validation.errors.map((error) => <p key={error} className="flex gap-2 text-[11px] leading-4 text-rose-300"><AlertCircle size={13} className="mt-0.5 shrink-0" />{error}</p>)}{validation.valid && validation.execution_levels.map((level, index) => <div key={index} className="rounded-lg border border-slate-700 p-2"><p className="text-[9px] uppercase tracking-wider text-slate-500">Etapa {index + 1} · {level.length > 1 ? "Paralelo" : "Sequencial"}</p><p className="mt-1 text-[11px] text-slate-200">{level.join(" + ")}</p></div>)}</div> : <p className="text-[11px] leading-5 text-slate-500">Valide o grafo para detectar ciclos, conexões inválidas e visualizar os grupos que podem rodar em paralelo.</p>}
            {message && <p className="mt-3 border-t border-slate-800 pt-3 text-[11px] leading-4 text-slate-400">{message}</p>}
          </div>
          <div className="rounded-xl border border-slate-800 bg-[#101720] p-4"><div className="flex items-start gap-2"><Copy size={14} className="mt-0.5 text-cyan-200" /><p className="text-[10px] leading-4 text-slate-500">O editor salva templates e valida o DAG. A execução coordenada, coleta dos resultados e injeção automática de contexto serão conectadas ao Workflow Runner na próxima iteração do motor.</p></div></div>
        </aside>
      </div>
      {message && <p className="text-xs text-slate-400">{message}</p>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block space-y-1.5"><span className="block text-[10px] text-slate-500">{label}</span>{children}</label>;
}

function EdgeInspector({ edge, onChange, onDelete }: { edge: ContextEdge | null; onChange: (passContext: boolean) => void; onDelete: () => void }) {
  if (!edge) return <p className="text-xs text-slate-500">Conexão não encontrada.</p>;
  const enabled = edge.data?.pass_context ?? true;
  return <div className="space-y-3">
    <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-3"><p className="text-[10px] uppercase tracking-wider text-slate-500">Dependência</p><p className="mt-1 break-all text-xs text-slate-200">{edge.source} → {edge.target}</p></div>
    <label className="flex items-start gap-2 rounded-lg border border-slate-700 p-3"><input type="checkbox" checked={enabled} onChange={(event) => onChange(event.target.checked)} className="mt-0.5 accent-cyan-300" /><span><span className="block text-xs text-slate-200">Passar contexto ao próximo agente</span><span className="mt-1 block text-[10px] leading-4 text-slate-500">Quando ativado, a saída estruturada deste nó será incluída na entrada do nó conectado.</span></span></label>
    <button onClick={onDelete} className="flex items-center gap-2 rounded-lg border border-rose-500/20 px-3 py-2 text-[10px] text-rose-300 hover:bg-rose-500/10"><Trash2 size={12} /> Excluir conexão</button>
  </div>;
}
