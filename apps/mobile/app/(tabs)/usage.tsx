import { useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { EmptyState, PageHeader, Panel, Pill, Screen, formatTokens } from "../../src/components/ui";
import { useRemote } from "../../src/providers/RemoteProvider";
import type { ProviderUsage, QuotaStatus } from "@orchestrator/shared-types";

const names = { claude_code: "Claude Code", codex: "Codex CLI", antigravity: "Antigravity" } as const;
const quotaText: Record<QuotaStatus, string> = { normal: "Normal", rate_limited: "Rate limit", quota_exceeded: "Cota excedida", unknown: "Desconhecido" };
const quotaTone: Record<QuotaStatus, "green" | "amber" | "red" | "neutral"> = { normal: "green", rate_limited: "amber", quota_exceeded: "red", unknown: "neutral" };
function Metric({ label, value }: { label: string; value: string }) {
  return <View className="flex-1 rounded-xl border border-line bg-canvas p-3"><Text className="text-base font-bold text-white">{value}</Text><Text className="mt-1 text-[9px] text-muted">{label}</Text></View>;
}
function ProviderCard({ provider }: { provider: ProviderUsage }) {
  const liveTotal = provider.live.input_tokens + provider.live.output_tokens + provider.live.cache_read_tokens + provider.live.cache_creation_tokens;
  const historicalTotal = provider.historical.input_tokens + provider.historical.output_tokens + provider.historical.cache_read_tokens + provider.historical.cache_creation_tokens;
  const seconds = provider.execution_seconds;
  const duration = seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return <Panel className="mb-3">
    <View className="flex-row items-center justify-between gap-2"><Text className="text-sm font-semibold text-white">{names[provider.provider]}</Text><Pill tone={quotaTone[provider.quota_status]}>{quotaText[provider.quota_status]}</Pill></View>
    <View className="mt-3 flex-row gap-2"><Metric label="Tokens históricos" value={provider.historical_available ? formatTokens(historicalTotal) : "N/D"} /><Metric label="Tokens ao vivo" value={provider.live_available ? formatTokens(liveTotal) : "N/D"} /></View>
    <View className="mt-2 flex-row gap-2"><Metric label="Sessões lidas" value={provider.historical_available ? String(provider.sessions_scanned) : "N/D"} /><Metric label="Tempo de execução" value={duration} /></View>
    <View className="mt-3 border-t border-line pt-3"><Text className="text-[9px] font-semibold uppercase tracking-widest text-muted">Disponibilidade</Text><View className="mt-2 flex-row flex-wrap gap-2"><Pill tone={provider.historical_available ? "green" : "neutral"}>Histórico {provider.historical_available ? "disponível" : "indisponível"}</Pill><Pill tone={provider.live_available ? "green" : "neutral"}>Live {provider.live_available ? "disponível" : "sem dados"}</Pill><Pill tone="neutral">Cota oficial não exposta</Pill></View>
      {provider.notes.map((note, index) => <Text key={index} className="mt-2 text-[9px] leading-4 text-muted">{note}</Text>)}
    </View>
  </Panel>;
}

export default function UsageScreen() {
  const insets = useSafeAreaInsets();
  const { connection, usage, refresh } = useRemote();
  const [refreshing, setRefreshing] = useState(false);
  async function onRefresh() { setRefreshing(true); try { await refresh(); } finally { setRefreshing(false); } }
  return <Screen>
    <ScrollView className="flex-1 px-5" contentContainerStyle={{ paddingTop: Math.max(insets.top, 16) + 8, paddingBottom: 28 }} refreshControl={<RefreshControl tintColor="#c4b5fd" refreshing={refreshing} onRefresh={() => void onRefresh()} />}>
      <PageHeader eyebrow="TELEMETRY" title="Usage" subtitle={usage ? `Atualizado ${new Date(usage.generated_at).toLocaleTimeString()}` : "Consumo observado nos CLIs locais."} />
      {!connection ? <EmptyState title="Conecte um Host" detail="As métricas são calculadas no computador onde os CLIs estão instalados." /> : !usage ? <EmptyState title="Métricas indisponíveis" detail="Atualize a conexão ou verifique se o servidor remoto está respondendo." /> : <>
        {usage.providers.map((provider) => <ProviderCard key={provider.provider} provider={provider} />)}
        <View className="rounded-xl border border-line bg-panel p-3"><Text className="text-[10px] leading-5 text-muted">Tokens históricos e tokens ao vivo são apresentados separadamente para evitar dupla contagem. Este painel não representa o saldo oficial da assinatura: os CLIs não fornecem uma API unificada de cotas por esta integração.</Text></View>
      </>}
    </ScrollView>
  </Screen>;
}
