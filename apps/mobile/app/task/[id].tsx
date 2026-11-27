import { useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ActionButton, PageHeader, Panel, Pill, Screen } from "../../src/components/ui";
import { useRemote } from "../../src/providers/RemoteProvider";
import type { TaskEvent, TaskStatus } from "@orchestrator/shared-types";

const labels: Record<TaskStatus, string> = { queued: "Na fila", starting: "Iniciando", running: "Executando", cancelling: "Interrompendo", awaiting_approval: "Aguardando aprovação", succeeded: "Concluído", failed: "Erro", quota_exceeded: "Cota excedida", cancelled: "Cancelado" };
function tone(status: TaskStatus): "neutral" | "green" | "amber" | "red" | "purple" { return status === "succeeded" ? "green" : status === "running" ? "purple" : status === "failed" || status === "quota_exceeded" ? "red" : status === "queued" || status === "awaiting_approval" || status === "starting" ? "amber" : "neutral"; }
function eventText(event: TaskEvent) {
  const payload = event.payload;
  if (payload.type === "output") return payload.data.line;
  if (payload.type === "file_changed") return `Arquivo alterado: ${payload.data.path}`;
  if (payload.type === "state_changed") return `Estado: ${labels[payload.data.status]}`;
  if (payload.type === "exited") return `Processo encerrado · código ${payload.data.code ?? "desconhecido"}`;
  return payload.data.message;
}

export default function TaskDetailScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const id = String(params.id ?? "");
  const { tasks, events, cancelTask } = useRemote();
  const [stopping, setStopping] = useState(false);
  const task = tasks.find((item) => item.task_id === id);
  const taskEvents = useMemo(() => events.filter((event) => event.task_id === id).slice(-400), [events, id]);
  async function stop() {
    Alert.alert("Interromper execução?", "O Host enviará um sinal de interrupção ao CLI.", [
      { text: "Voltar", style: "cancel" },
      { text: "Interromper", style: "destructive", onPress: () => {
        setStopping(true);
        void cancelTask(id).catch((error) => Alert.alert("Falha ao interromper", String(error))).finally(() => setStopping(false));
      } },
    ]);
  }
  return <Screen>
    <ScrollView className="flex-1 px-5" contentContainerStyle={{ paddingTop: Math.max(insets.top, 16) + 10, paddingBottom: 32 }}>
      <PageHeader eyebrow="TASK DETAIL" title={task?.display_name ?? "Execução"} subtitle={id} action={<Text onPress={() => router.back()} className="rounded-lg border border-line px-3 py-2 text-xs text-zinc-300">Voltar</Text>} />
      {!task ? <Panel><Text className="text-xs leading-5 text-muted">Esta tarefa não está no snapshot local. Atualize o painel ou reconecte ao Host para recuperar o estado.</Text></Panel> : <>
        <Panel className="mb-4">
          <View className="flex-row items-center justify-between"><Text className="text-xs font-semibold text-white">Estado da tarefa</Text><Pill tone={tone(task.status)}>{labels[task.status]}</Pill></View>
          <View className="mt-3 flex-row flex-wrap gap-2"><Pill>{task.provider ?? task.program}</Pill><Pill>{task.model ?? "Modelo padrão"}</Pill><Pill>{task.effort ?? "Effort padrão"}</Pill></View>
          <Text className="mt-3 text-[10px] leading-5 text-muted">Diretório: {task.cwd}</Text>
          {task.current_file ? <Text className="mt-1 text-[10px] leading-5 text-cyan-200">Arquivo recente: {task.current_file}</Text> : null}
          {task.last_error ? <Text className="mt-2 text-[10px] leading-5 text-rose-300">{task.last_error}</Text> : null}
          {!["succeeded", "failed", "quota_exceeded", "cancelled"].includes(task.status) ? <View className="mt-4"><ActionButton title="Interromper agente" variant="danger" onPress={() => void stop()} loading={stopping} /></View> : null}
        </Panel>
        <View className="mb-2 flex-row items-center justify-between"><Text className="text-sm font-semibold text-white">Log ao vivo</Text><Text className="text-[10px] text-muted">{taskEvents.length} eventos locais</Text></View>
        <Panel className="px-3 py-2">
          {taskEvents.length === 0 ? <Text className="py-5 text-center text-[10px] text-muted">Nenhum evento recebido nesta conexão. O snapshot contém apenas o estado atual.</Text> : taskEvents.map((event) => {
            const isError = event.payload.type === "error" || (event.payload.type === "output" && event.payload.data.stream === "stderr");
            return <View key={`${event.sequence}-${event.emitted_at}`} className="border-b border-line py-2">
              <Text className="text-[9px] text-zinc-600">{new Date(event.emitted_at).toLocaleTimeString()} · #{event.sequence}</Text>
              <Text selectable className={`mt-1 text-[10px] leading-5 ${isError ? "text-rose-300" : "text-zinc-300"}`}>{eventText(event)}</Text>
            </View>;
          })}
        </Panel>
      </>}
    </ScrollView>
  </Screen>;
}
