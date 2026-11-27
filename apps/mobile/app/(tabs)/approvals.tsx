import { useEffect, useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { EmptyState, PageHeader, Panel, Pill, Screen } from "../../src/components/ui";
import { useRemote } from "../../src/providers/RemoteProvider";

const actionLabels = { read: "Leitura", write: "Escrita", execute: "Execução", network: "Rede", destructive: "Destrutiva" } as const;
const providerLabels: Record<string, string> = { claude_code: "Claude Code", codex: "Codex CLI", antigravity: "Antigravity" };

export default function ApprovalsScreen() {
  const insets = useSafeAreaInsets();
  const { connection, approvals, refresh, decideApproval } = useRemote();
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  async function onRefresh() { setRefreshing(true); try { await refresh(); } finally { setRefreshing(false); } }
  useEffect(() => {
    if (!connection) return;
    const timer = setInterval(() => { void refresh(); }, 3_000);
    return () => clearInterval(timer);
  }, [connection, refresh]);
  async function decide(id: string, approve: boolean) {
    setBusyId(id);
    try { await decideApproval(id, approve); }
    catch (error) { Alert.alert("Não foi possível registrar a decisão", error instanceof Error ? error.message : String(error)); }
    finally { setBusyId(null); }
  }
  const pending = approvals.filter((item) => item.status === "pending");
  const history = approvals.filter((item) => item.status !== "pending").slice(0, 20);
  return <Screen>
    <ScrollView className="flex-1 px-5" contentContainerStyle={{ paddingTop: Math.max(insets.top, 16) + 8, paddingBottom: 28 }} refreshControl={<RefreshControl tintColor="#c4b5fd" refreshing={refreshing} onRefresh={() => void onRefresh()} />}>
      <PageHeader eyebrow="HUMAN IN THE LOOP" title="Aprovações" subtitle="Aprovações nativas do Codex e solicitações de permissão dos adapters." action={<Pill tone={pending.length ? "amber" : "neutral"}>{pending.length} pendentes</Pill>} />
      {!connection ? <EmptyState title="Conecte um Host" detail="Pareie o Desktop para consultar e decidir solicitações de permissão." /> : <>
        {pending.length === 0 ? <Panel className="mb-4"><Text className="text-xs font-semibold text-zinc-100">Nenhuma solicitação pendente</Text><Text className="mt-2 text-[10px] leading-5 text-muted">A fila está conectada ao Host. Solicitações nativas do Codex aparecem aqui e a decisão é enviada de volta à sessão pausada.</Text></Panel> : pending.map((item) => <Panel key={item.id} className="mb-3">
          <View className="flex-row items-center justify-between gap-2"><Text className="text-xs font-semibold text-zinc-100">{item.tool_name}</Text><Pill tone={item.action === "destructive" ? "red" : "amber"}>{actionLabels[item.action]}</Pill></View>
          <Text className="mt-2 text-xs text-zinc-300">{item.summary}</Text>
          <Text className="mt-2 text-[10px] text-muted">{providerLabels[item.provider] ?? item.provider} · Sessão/tarefa {item.task_id.slice(0, 8)}</Text>
          <View className="mt-3 rounded-lg bg-canvas p-3"><Text selectable className="font-mono text-[10px] leading-5 text-zinc-300">{item.input_preview}</Text></View>
          <Text className="mt-2 text-[9px] text-muted">Expira em {new Date(item.expires_at).toLocaleString()}</Text>
          <View className="mt-3 flex-row gap-2"><Pressable disabled={busyId === item.id} onPress={() => void decide(item.id, false)} className="flex-1 items-center rounded-lg border border-rose-500/30 px-3 py-3"><Text className="text-[10px] font-semibold text-rose-300">Negar</Text></Pressable><Pressable disabled={busyId === item.id} onPress={() => void decide(item.id, true)} className="flex-1 items-center rounded-lg bg-violet-300 px-3 py-3"><Text className="text-[10px] font-semibold text-zinc-950">Aprovar</Text></Pressable></View>
        </Panel>)}
        {history.length > 0 ? <><Text className="mb-2 mt-4 text-[10px] font-semibold uppercase tracking-widest text-muted">Histórico recente</Text>{history.map((item) => <Panel key={item.id} className="mb-2"><View className="flex-row items-center justify-between"><Text className="text-xs text-zinc-200">{item.tool_name} · {actionLabels[item.action]}</Text><Pill tone={item.status === "approved" ? "green" : item.status === "denied" ? "red" : "neutral"}>{item.status === "approved" ? "Aprovada" : item.status === "denied" ? "Negada" : "Expirada"}</Pill></View><Text className="mt-1 text-[9px] text-muted">{new Date(item.decided_at ?? item.expires_at).toLocaleString()}</Text></Panel>)}</> : null}
      </>}
      <View className="mt-4"><Text className="text-[10px] leading-5 text-muted">As decisões são registradas no Host. Para solicitações nativas do Codex, aprovar ou negar nesta tela responde diretamente ao pedido JSON-RPC que mantém a sessão pausada. Outros provedores só terão retomada nativa quando seus adapters interativos forem integrados.</Text></View>
    </ScrollView>
  </Screen>;
}
