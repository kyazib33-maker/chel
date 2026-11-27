import { useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ActionButton, EmptyState, Field, PageHeader, Panel, Pill, Screen } from "../../src/components/ui";
import { useRemote } from "../../src/providers/RemoteProvider";

const providerLabels = { claude_code: "Claude Code", codex: "Codex", antigravity: "Antigravity" } as const;
const activeStatuses = new Set(["queued", "running"]);

export default function WorkflowsScreen() {
  const insets = useSafeAreaInsets();
  const { connection, workflows, workflowExecutions, workflowCheckpoints, refresh, startWorkflowRemote, cancelWorkflowRemote } = useRemote();
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [repository, setRepository] = useState("");
  const [prompt, setPrompt] = useState("");
  const [starting, setStarting] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);

  async function onRefresh() { setRefreshing(true); try { await refresh(); } finally { setRefreshing(false); } }
  async function runWorkflow(workflowId: string) {
    if (!repository.trim() || !prompt.trim()) { Alert.alert("Dados necessários", "Informe o caminho do projeto no Host e o objetivo do workflow."); return; }
    setStarting(workflowId);
    try {
      const runId = await startWorkflowRemote(workflowId, repository.trim(), prompt.trim());
      Alert.alert("Workflow iniciado", `Execução ${runId} iniciada no computador.`);
      setPrompt("");
      await refresh();
    } catch (error) { Alert.alert("Não foi possível iniciar", error instanceof Error ? error.message : String(error)); }
    finally { setStarting(null); }
  }
  async function cancel(runId: string) {
    setCancelling(runId);
    try { await cancelWorkflowRemote(runId); }
    catch (error) { Alert.alert("Falha ao cancelar", error instanceof Error ? error.message : String(error)); }
    finally { setCancelling(null); }
  }

  return <Screen>
    <ScrollView className="flex-1 px-5" contentContainerStyle={{ paddingTop: Math.max(insets.top, 16) + 8, paddingBottom: 28 }} refreshControl={<RefreshControl tintColor="#c4b5fd" refreshing={refreshing} onRefresh={() => void onRefresh()} />}>
      <PageHeader eyebrow="REMOTE WORKFLOWS" title="Fluxos multiagente" subtitle="Inicie execuções no Host e acompanhe os agentes pelo celular." />
      {!connection ? <EmptyState title="Conecte um Host" detail="Pareie o Desktop para consultar e executar workflows remotamente." /> : null}

      {connection && workflowExecutions.length > 0 ? <View className="mb-5">
        <Text className="mb-3 text-[10px] font-bold uppercase tracking-[2px] text-muted">Execuções recentes</Text>
        {workflowExecutions.map((run) => <Panel key={run.run_id} className="mb-2">
          <View className="flex-row items-center justify-between gap-2"><Text numberOfLines={1} className="flex-1 text-sm font-semibold text-white">{run.workflow_name}</Text><Pill tone={run.status === "succeeded" ? "green" : run.status === "failed" ? "red" : run.status === "cancelled" ? "amber" : "blue"}>{run.status}</Pill></View>
          <Text className="mt-1 text-[9px] text-muted">{new Date(run.started_at).toLocaleString()} · {run.run_id.slice(0, 8)}</Text>
          {run.events.slice(-6).map((event, index) => <View key={`${event.at}-${index}`} className="mt-2 flex-row items-center justify-between"><Text className="flex-1 text-[10px] text-zinc-300">{event.node_id ?? "Workflow"} · {event.event}</Text><Text className="text-[9px] text-muted">{event.status}</Text></View>)}
          {run.result?.nodes?.map((node) => <View key={node.node_id} className="mt-2 rounded-lg bg-canvas p-2"><Text className="text-[10px] font-semibold text-zinc-200">{node.node_id} · {node.status}</Text>{node.error ? <Text className="mt-1 text-[9px] text-rose-300">{node.error}</Text> : null}</View>)}
          {run.error ? <Text className="mt-2 text-[10px] text-rose-300">{run.error}</Text> : null}
          {activeStatuses.has(run.status) ? <View className="mt-3"><ActionButton title="Cancelar workflow" variant="danger" loading={cancelling === run.run_id} onPress={() => void cancel(run.run_id)} /></View> : null}
        </Panel>)}
      </View> : null}

      {connection && workflowCheckpoints.length > 0 ? <View className="mb-5">
        <Text className="mb-3 text-[10px] font-bold uppercase tracking-[2px] text-muted">Checkpoints e recuperação</Text>
        {workflowCheckpoints.filter((item) => item.status === "interrupted" || item.status === "cancelled" || item.status === "failed").map((item) => <Panel key={item.run_id} className="mb-2">
          <View className="flex-row items-center justify-between"><Text className="text-xs font-semibold text-white">{item.workflow.name}</Text><Pill tone={item.status === "interrupted" ? "amber" : item.status === "failed" ? "red" : "blue"}>{item.status}</Pill></View>
          <Text className="mt-1 text-[9px] text-muted">{item.run_id.slice(0, 8)} · {item.completed_nodes.length} agentes com checkpoint</Text>
          {item.recovery_note ? <Text className="mt-2 text-[10px] leading-4 text-amber-200">{item.recovery_note}</Text> : null}
          <Text className="mt-2 text-[9px] text-muted">Revise os worktrees no Host antes de decidir se deve reexecutar agentes pendentes.</Text>
        </Panel>)}
      </View> : null}

      {connection && workflows.length === 0 ? <EmptyState title="Nenhum workflow salvo" detail="Crie e salve um fluxo no construtor visual do Desktop. Ele aparecerá aqui quando o Host estiver conectado." /> : null}
      {connection && workflows.length > 0 ? <View>
        <Text className="mb-3 text-[10px] font-bold uppercase tracking-[2px] text-muted">Biblioteca de fluxos</Text>
        {workflows.map((workflow) => <Panel key={workflow.id} className="mb-3">
          <Pressable onPress={() => setExpanded((current) => current === workflow.id ? null : workflow.id)}>
            <View className="flex-row items-center justify-between gap-2"><Text numberOfLines={1} className="flex-1 text-sm font-semibold text-white">{workflow.name}</Text><Pill tone="purple">{workflow.nodes.length} agentes</Pill></View>
            <Text className="mt-2 text-[10px] text-muted">Atualizado em {new Date(workflow.updated_at).toLocaleString()}</Text>
            <View className="mt-3 flex-row flex-wrap gap-1.5">{workflow.nodes.slice(0, 4).map((node) => <Pill key={node.id}>{providerLabels[node.provider]}</Pill>)}{workflow.nodes.length > 4 ? <Pill>+{workflow.nodes.length - 4}</Pill> : null}</View>
          </Pressable>
          {expanded === workflow.id ? <View className="mt-4 border-t border-line pt-3">
            {workflow.nodes.map((node, index) => <View key={node.id} className="mb-2 flex-row items-center gap-2"><View className="h-6 w-6 items-center justify-center rounded-md bg-canvas"><Text className="text-[9px] text-accent">{index + 1}</Text></View><View className="flex-1"><Text className="text-xs font-semibold text-zinc-200">{node.name}</Text><Text className="text-[9px] text-muted">{providerLabels[node.provider]} · {node.model ?? "Modelo padrão"} · {node.effort ?? "Effort padrão"}</Text></View></View>)}
            <View className="mt-4"><Field label="Caminho do projeto no Host" value={repository} onChangeText={setRepository} placeholder="C:\\Projetos\\MeuProjeto ou /home/user/projeto" autoCapitalize="none" /></View>
            <View className="mt-3"><Field label="Objetivo da execução" value={prompt} onChangeText={setPrompt} placeholder="Descreva o que os agentes devem realizar..." multiline numberOfLines={4} textAlignVertical="top" /></View>
            <Text className="mt-2 text-[9px] leading-4 text-muted">O caminho é interpretado no computador Host e precisa estar dentro da pasta autorizada nas configurações do servidor remoto.</Text>
            <View className="mt-3"><ActionButton title="Executar neste computador" loading={starting === workflow.id} onPress={() => void runWorkflow(workflow.id)} /></View>
          </View> : null}
          <View className="mt-3"><ActionButton title={expanded === workflow.id ? "Ocultar detalhes" : "Configurar execução"} variant="secondary" onPress={() => setExpanded((current) => current === workflow.id ? null : workflow.id)} /></View>
        </Panel>)}
      </View> : null}
    </ScrollView>
  </Screen>;
}
