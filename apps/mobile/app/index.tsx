import { useState } from "react";
import { Alert, FlatList, Modal, Pressable, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { brand, finished, newId, useChel } from "../src/lib/chel";
import { IconButton, StatusDot } from "../src/components/ui";
import { UpdateNotice } from "../src/components/UpdateNotice";

function ago(t: number) {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "agora" : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
}

export default function Conversations() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { status, state, error, command } = useChel();
  const chats = [...state.chats].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const options = (c: { id: string; title: string; pinned?: boolean }) => Alert.alert(c.title, undefined, [
    { text: "Renomear", onPress: () => setRenaming({ id: c.id, title: c.title }) },
    { text: c.pinned ? "Desafixar" : "Fixar no topo", onPress: () => void command({ type: "pin_chat", chat_id: c.id }) },
    { text: "Apagar", style: "destructive", onPress: () => Alert.alert("Apagar conversa?", c.title, [{ text: "Cancelar", style: "cancel" }, { text: "Apagar", style: "destructive", onPress: () => void command({ type: "delete_chat", chat_id: c.id }) }]) },
  ], { cancelable: true });

  if (status === "unpaired" || status === "loading") return <View className="flex-1 items-center justify-center bg-canvas px-8" style={{ paddingTop: insets.top }}>
    <View className="h-14 w-14 items-center justify-center rounded-2xl bg-violet-500"><Text className="text-2xl font-bold text-white">C</Text></View>
    <Text className="mt-5 text-2xl font-semibold text-white">Chel</Text>
    <Text className="mt-2 text-center text-sm leading-5 text-muted">Use as IAs do seu computador pelo celular. No Chel do PC, abra “Usar no celular” e gere um código.</Text>
    <Pressable onPress={() => router.push("/connect")} className="mt-8 w-full items-center rounded-xl bg-zinc-100 py-3.5 active:opacity-80"><Text className="font-semibold text-zinc-900">Conectar ao computador</Text></Pressable>
  </View>;

  return <View className="flex-1 bg-canvas" style={{ paddingTop: insets.top }}>
    <View className="flex-row items-center gap-2 px-4 pb-2 pt-3">
      <View className="h-8 w-8 items-center justify-center rounded-lg bg-violet-500"><Text className="font-bold text-white">C</Text></View>
      <View className="flex-1"><Text className="text-lg font-semibold text-white">Chel</Text><View className="flex-row items-center gap-1.5"><StatusDot status={status} /><Text className="text-[11px] text-muted">{status === "online" ? "Conectado ao computador" : "Sem conexão com o computador"}</Text></View></View>
      <IconButton label="⚡" onPress={() => router.push("/activity")} />
      <IconButton label="⚙" onPress={() => router.push("/connect")} />
    </View>
    <UpdateNotice />
    {status === "offline" && <Text className="mx-4 mb-2 rounded-lg bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200">Não consegui falar com o PC. O Chel está aberto e o Tailscale ligado no celular? {error ? `(${error})` : ""}</Text>}
    {state.working.length > 0 && <Pressable onPress={() => router.push("/activity")} className="mx-4 mb-2 flex-row items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2.5">
      {state.working.slice(0, 3).map((w) => w.provider ? <Text key={w.task_id} style={{ color: brand[w.provider].color }}>{brand[w.provider].glyph}</Text> : null)}
      <Text className="flex-1 text-[13px] text-zinc-300">{state.working.length} IA(s) trabalhando</Text><Text className="text-muted">›</Text>
    </Pressable>}
    <FlatList data={chats} keyExtractor={(c) => c.id} contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 110 }}
      ListEmptyComponent={<Text className="mt-16 text-center text-sm text-muted">Nenhuma conversa ainda.</Text>}
      renderItem={({ item }) => {
        const last = item.turns[item.turns.length - 1];
        const live = last && last.status && !finished.includes(last.status) ? last.provider : null;
        return <Pressable onPress={() => router.push(`/chat/${item.id}`)} onLongPress={() => options(item)} className="flex-row items-center gap-3 rounded-xl px-3 py-3 active:bg-raised">
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: live ? brand[live].color : "transparent" }} />
          <View className="flex-1"><Text numberOfLines={1} className="text-[15px] text-zinc-100">{item.title}</Text>
            {last ? <Text numberOfLines={1} className="mt-0.5 text-[12px] text-muted">{last.answer ? last.answer.replace(/\s+/g, " ") : last.prompt}</Text> : null}</View>
          <Text className="text-[11px] text-muted">{item.pinned ? "📌" : ago(item.updatedAt)}</Text>
        </Pressable>;
      }} />
    <Pressable onPress={() => router.push(`/chat/${newId()}`)} className="absolute right-5 flex-row items-center gap-2 rounded-2xl bg-zinc-100 px-5 py-3.5 active:opacity-80" style={{ bottom: insets.bottom + 20 }}>
      <Text className="text-base font-semibold text-zinc-900">＋ Nova conversa</Text>
    </Pressable>
    <Modal visible={!!renaming} transparent animationType="fade" onRequestClose={() => setRenaming(null)}>
      <View className="flex-1 justify-center bg-black/60 px-8"><View className="rounded-2xl border border-line bg-panel p-4">
        <Text className="mb-3 text-[15px] font-semibold text-white">Renomear conversa</Text>
        <TextInput autoFocus value={renaming?.title ?? ""} onChangeText={(t) => setRenaming((r) => r && { ...r, title: t })} className="rounded-xl border border-line bg-canvas px-3 py-2.5 text-[15px] text-white" />
        <View className="mt-4 flex-row justify-end gap-2">
          <Pressable onPress={() => setRenaming(null)} className="rounded-lg px-4 py-2"><Text className="text-muted">Cancelar</Text></Pressable>
          <Pressable onPress={() => { if (renaming?.title.trim()) void command({ type: "rename_chat", chat_id: renaming.id, title: renaming.title.trim() }); setRenaming(null); }} className="rounded-lg bg-zinc-100 px-4 py-2"><Text className="font-semibold text-zinc-900">Salvar</Text></Pressable>
        </View>
      </View></View>
    </Modal>
  </View>;
}
