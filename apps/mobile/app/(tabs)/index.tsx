import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ActionButton, EmptyState, PageHeader, Panel, Pill, Screen, formatTokens } from "../../src/components/ui";
import { useRemote } from "../../src/providers/RemoteProvider";
import type { TaskSnapshot, TaskStatus } from "@orchestrator/shared-types";

const providerNames = { claude_code: "Claude Code", codex: "Codex CLI", antigravity: "Antigravity" } as const;
const statusNames: Record<TaskStatus, string> = {
  queued: "Na fila", starting: "Iniciando", running: "Executando", cancelling: "Interrompendo",
  awaiting_approval: "Aguardando aprovação", succeeded: "Concluído", failed: "Erro", quota_exceeded: "Cota", cancelled: "Cancelado",
};
const statusTone = (status: TaskStatus): "neutral" | "green" | "amber" | "red" | "purple" => {
  if (status === "succeeded") return "green";
  if (status === "awaiting_approval" || status === "queued" || status === "starting") return "amber";
  if (status === "failed" || status === "quota_exceeded") return "red";
  if (status === "running") return "purple";
  return "neutral";
};
function shortElapsed(task: TaskSnapshot) {
  if (!task.started_at) return "Aguardando";
  const until = task.finished_at ? new Date(task.finished_at).getTime() : Date.now();
  const seconds = Math.max(0, Math.floor((until - new Date(task.started_at).getTime()) / 1000));
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m` : seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}
function TaskCard({ task, onPress }: { task: TaskSnapshot; onPress: () => void }) {
  return <Pressable onPress={onPress} className="mb-2 rounded-xl border border-line bg-panel p-3.5 active:opacity-70">
    <View className="flex-row items-start justify-between gap-3">
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="text-sm font-semibold text-white">{task.display_name}</Text>
        <Text className="mt-1 text-[10px] text-muted">{task.provider ? providerNames[task.provider] : task.program} · {task.model ?? "Modelo padrão"}</Text>
      </View>
      <Pill tone={statusTone(task.status)}>{statusNames[task.status]}</Pill>
    </View>
    <View className="mt-3 flex-row items-center justify-between">
      <Text numberOfLines={1} className="mr-2 flex-1 text-[10px] text-zinc-500">{task.current_file ?? task.cwd}</Text>
      <Text className="text-[10px] text-zinc-400">{shortElapsed(task)}</Text>
    </View>
  </Pressable>;
}

export default function DashboardScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { connection, connectionStatus, tasks, usage, error, refresh } = useRemote();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => { setRefreshing(true); try { await refresh(); } finally { setRefreshing(false); } }, [refresh]);
  const active = tasks.filter((task) => ["queued", "starting", "running", "cancelling", "awaiting_approval"].includes(task.status));
  const healthy = connectionStatus === "connected";
  const totalLive = usage?.providers.reduce((sum, provider) => sum + provider.live.input_tokens + provider.live.output_tokens, 0) ?? 0;

  return <Screen>
    <ScrollView className="flex-1 px-5" contentContainerStyle={{ paddingTop: Math.max(insets.top, 16) + 8, paddingBottom: 28 }} refreshControl={<RefreshControl tintColor="#c4b5fd" refreshing={refreshing} onRefresh={() => void onRefresh()} />}>
      <PageHeader eyebrow="PSYLIUM · REMOTE" title="Painel de agentes" subtitle="Acompanhe as execuções no computador em tempo real." action={<Pressable onPress={() => router.push("/connect")} className="rounded-xl border border-line bg-panel px-3 py-2"><Text className="text-[10px] font-semibold text-accent">{connection ? "Host" : "Conectar"}</Text></Pressable>} />

      <Panel className="mb-4">
        <View className="flex-row items-center justify-between">
          <View className="flex-1">
            <Text className="text-[10px] font-semibold uppercase tracking-widest text-muted">Computador</Text>
            <Text className="mt-1 text-sm font-semibold text-zinc-100">{connection ? new URL(connection.endpoint).host : "Nenhum Host pareado"}</Text>
          </View>
          <Pill tone={healthy ? "green" : connectionStatus === "reconnecting" || connectionStatus === "connecting" ? "amber" : "neutral"}>
            {healthy ? "Online" : connectionStatus === "reconnecting" ? "Reconectando" : connectionStatus === "connecting" ? "Conectando" : connectionStatus === "loading" ? "Carregando" : "Offline"}
          </Pill>
        </View>
        {!connection ? <View className="mt-4"><ActionButton title="Parear com o Desktop" onPress={() => router.push("/connect")} /></View> : <View className="mt-3 flex-row gap-4">
          <View><Text className="text-xl font-bold text-white">{active.length}</Text><Text className="text-[9px] text-muted">ativas</Text></View>
          <View><Text className="text-xl font-bold text-white">{tasks.length}</Text><Text className="text-[9px] text-muted">retidas</Text></View>
          <View><Text className="text-xl font-bold text-white">{formatTokens(totalLive)}</Text><Text className="text-[9px] text-muted">tokens live</Text></View>
        </View>}
      </Panel>

      {error ? <View className="mb-3 rounded-xl border border-rose-500/20 bg-rose-500/10 p-3"><Text className="text-xs leading-5 text-rose-300">{error}</Text></View> : null}

      <View className="mb-3 flex-row items-center justify-between"><Text className="text-sm font-semibold text-white">Execuções recentes</Text><Text className="text-[10px] text-muted">{active.length} em andamento</Text></View>
      {!connection ? <EmptyState title="Conecte seu computador" detail="O app mobile controla os CLIs que estão instalados e autenticados no Desktop. Faça o pareamento por QR Code para começar." action={<ActionButton title="Abrir leitor de QR Code" onPress={() => router.push("/connect")} />} />
        : tasks.length === 0 ? <EmptyState title="Nenhuma tarefa ainda" detail="Envie um prompt pela aba Novo ou inicie uma execução no Desktop." />
        : tasks.slice(0, 30).map((task) => <TaskCard key={task.task_id} task={task} onPress={() => router.push({ pathname: "/task/[id]", params: { id: task.task_id } })} />)}

      {connection && !healthy && connectionStatus !== "loading" ? <View className="mt-3"><ActionButton title="Tentar atualizar" variant="secondary" onPress={() => void onRefresh()} loading={refreshing} /></View> : null}
    </ScrollView>
  </Screen>;
}
