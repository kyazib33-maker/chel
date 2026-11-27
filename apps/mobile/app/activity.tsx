import { Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { brand, effortName, useChel, type ProviderId } from "../src/lib/chel";
import { Chip, IconButton, Mark } from "../src/components/ui";

const order: ProviderId[] = ["claude_code", "codex", "antigravity"];
const bar = (pct: number) => pct <= 0 ? "#f43f5e" : pct < 20 ? "#f59e0b" : "#34d399";
function when(r: string | null) {
  if (!r) return "";
  const d = new Date(r);
  return !Number.isNaN(d.getTime()) && /^\d{4}-/.test(r) ? d.toLocaleString("pt-BR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : r.replace(/\s*\(.*\)$/, "");
}
function elapsed(from: number) { const s = Math.max(0, Math.round((Date.now() - from) / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}min`; }

export default function Activity() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { state } = useChel();

  return <View className="flex-1 bg-canvas" style={{ paddingTop: insets.top }}>
    <View className="flex-row items-center gap-1 border-b border-line px-2 pb-2 pt-2"><IconButton label="‹" onPress={() => router.back()} /><Text className="flex-1 text-[15px] font-medium text-white">Atividade</Text></View>
    <ScrollView contentContainerStyle={{ padding: 16, gap: 26, paddingBottom: insets.bottom + 24 }}>
      <View className="gap-2.5">
        <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted">Trabalhando agora</Text>
        {state.working.length === 0 && <Text className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-[13px] text-muted">Nenhuma IA trabalhando.</Text>}
        {state.working.map((w) => {
          const b = w.provider ? brand[w.provider] : null;
          return <Pressable key={w.task_id} onPress={() => router.push(`/chat/${w.chat_id}`)} className="rounded-xl border p-3" style={{ borderColor: (b?.color ?? "#3f3f46") + "44", backgroundColor: b?.soft }}>
            <View className="flex-row items-center gap-2">{w.provider && <Mark provider={w.provider} />}<Text style={{ color: b?.color }} className="text-[13px] font-semibold">{b?.name}</Text><Text className="ml-auto text-[11px] text-muted">{elapsed(w.since)}</Text></View>
            <Text numberOfLines={1} className="mt-1 text-[13px] text-zinc-300">{w.chat_title}</Text>
            <View className="mt-2 flex-row flex-wrap gap-1.5">{w.model ? <Chip>{w.model}</Chip> : null}{w.effort ? <Chip tone="#a1a1aa">esforço {effortName[w.effort] ?? w.effort}</Chip> : null}{w.status === "awaiting_approval" ? <Chip tone="#c4b5fd">aguardando permissão</Chip> : null}</View>
            {w.subagents.length > 0 && <View className="mt-2.5 gap-1 border-t border-white/5 pt-2">
              <Text className="text-[10px] uppercase tracking-wider text-muted">Subagentes</Text>
              {w.subagents.map((s, i) => <View key={i} className="flex-row items-center gap-1.5"><Text className={s.done ? "text-emerald-400" : "text-zinc-400"}>{s.done ? "✓" : "◌"}</Text><Text numberOfLines={1} className="flex-1 text-[12px] text-zinc-300">{s.description}</Text><Text className="text-[10px] text-muted">{s.kind}</Text></View>)}
            </View>}
          </Pressable>;
        })}
      </View>

      <View className="gap-4">
        <Text className="text-[11px] font-semibold uppercase tracking-wider text-muted">Uso das IAs</Text>
        {order.map((id) => {
          const q = state.quotas.find((x) => x.provider === id);
          return <View key={id} className="gap-2">
            <View className="flex-row items-center gap-2"><Mark provider={id} /><Text style={{ color: brand[id].color }} className="text-[14px] font-medium">{brand[id].name}</Text>
              <Text className={`ml-auto text-[11px] ${!q || q.error ? "text-muted" : q.available ? "text-emerald-400" : "text-rose-400"}`}>{!q ? "…" : q.error ? "indisponível" : q.available ? "disponível" : "sem cota"}</Text></View>
            {q?.windows.map((w) => <View key={w.label}>
              <View className="mb-1 flex-row justify-between"><Text className="text-[11px] text-zinc-400">{w.label}</Text><Text className="text-[11px] text-zinc-300">{Math.round(w.remaining_pct)}%</Text></View>
              <View className="h-1.5 overflow-hidden rounded-full bg-raised"><View style={{ width: `${Math.max(2, Math.min(100, w.remaining_pct))}%`, backgroundColor: bar(w.remaining_pct), height: "100%", borderRadius: 4 }} /></View>
              {w.resets ? <Text className="mt-0.5 text-[10px] text-muted">renova {when(w.resets)}</Text> : null}
            </View>)}
          </View>;
        })}
      </View>
    </ScrollView>
  </View>;
}
