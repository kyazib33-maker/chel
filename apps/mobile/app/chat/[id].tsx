import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { brand, effortName, finished, useChel, type ProviderId } from "../../src/lib/chel";
import { Chip, IconButton, Mark, Rich } from "../../src/components/ui";

const picks: Array<ProviderId | "auto"> = ["auto", "claude_code", "codex", "antigravity"];

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { state, command, status } = useChel();
  const chat = state.chats.find((c) => c.id === id);
  const [text, setText] = useState("");
  const [forced, setForced] = useState<ProviderId | "auto">("auto");
  const [pending, setPending] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const scroll = useRef<ScrollView>(null);
  const turns = chat?.turns ?? [];

  useEffect(() => { if (pending && turns.some((t) => t.prompt === pending)) setPending(null); }, [turns, pending]);
  useEffect(() => { setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 80); }, [turns.length, turns[turns.length - 1]?.answer, pending]);

  async function send() {
    const prompt = text.trim();
    if (!prompt) return;
    setText(""); setPending(prompt); setSendError(null);
    try { await command({ type: "send", chat_id: id, prompt, provider: forced, title: chat ? undefined : prompt.slice(0, 42) }); }
    catch (reason) { setPending(null); setText(prompt); setSendError(reason instanceof Error ? reason.message : String(reason)); }
  }

  return <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} className="flex-1 bg-canvas" style={{ paddingTop: insets.top }}>
    <View className="flex-row items-center gap-1 border-b border-line px-2 pb-2 pt-2">
      <IconButton label="‹" onPress={() => router.back()} />
      <Text numberOfLines={1} className="flex-1 text-[15px] font-medium text-white">{chat?.title ?? "Nova conversa"}</Text>
      <IconButton label="⚡" onPress={() => router.push("/activity")} />
    </View>

    <ScrollView ref={scroll} className="flex-1" contentContainerStyle={{ padding: 16, gap: 22 }}>
      {turns.length === 0 && !pending && <View className="mt-24 items-center"><View className="flex-row gap-3">{(["claude_code", "codex", "antigravity"] as ProviderId[]).map((p) => <Mark key={p} provider={p} size={22} />)}</View>
        <Text className="mt-4 text-xl font-semibold text-white">Como posso ajudar?</Text>
        <Text className="mt-2 px-6 text-center text-[13px] leading-5 text-muted">O Chel escolhe a IA, o modelo e o esforço, sempre gastando pouco. Para escolher você, diga “usa o Codex” ou toque numa IA abaixo.</Text></View>}
      {turns.map((t) => {
        const b = t.provider ? brand[t.provider] : null;
        const running = !!t.status && !finished.includes(t.status) && !t.error;
        return <View key={t.id} className="gap-3">
          <View className="max-w-[85%] self-end rounded-2xl rounded-br-md bg-raised px-4 py-2.5"><Text selectable className="text-[15px] leading-6 text-zinc-100">{t.prompt}</Text></View>
          <View className="gap-1.5">
            <View className="flex-row flex-wrap items-center gap-1.5">
              {t.provider && b ? <><Mark provider={t.provider} /><Text style={{ color: b.color }} className="text-[13px] font-semibold">{b.name}</Text></> : <Text className="text-[12px] text-muted">Escolhendo a IA…</Text>}
              {t.model ? <Chip>{t.model}</Chip> : null}
              {t.effort ? <Chip tone="#a1a1aa">esforço {effortName[t.effort] ?? t.effort}</Chip> : null}
              {running ? <ActivityIndicator size="small" color={b?.color ?? "#a1a1aa"} /> : null}
            </View>
            {t.notes.map((n, i) => <Text key={i} className="text-[12px] text-amber-300">{n}</Text>)}
            {t.error ? <Text className="text-[15px] text-rose-300">Não deu certo: {t.error}</Text>
              : t.answer ? <Rich text={t.answer} />
              : running ? <Text className="text-[14px] text-muted">Trabalhando…</Text>
              : t.status && finished.includes(t.status) ? <Text className="text-[14px] text-muted">A IA terminou sem enviar resposta em texto.</Text> : null}
            {t.status === "awaiting_approval" ? <Text className="text-[12px] text-violet-300">A IA está pedindo permissão — aprove no computador.</Text> : null}
            {running && t.task_id ? <Pressable onPress={() => void command({ type: "cancel", task_id: t.task_id })} className="mt-1 self-start rounded-md px-2 py-1 active:bg-raised"><Text className="text-[12px] text-muted">■ Parar</Text></Pressable> : null}
          </View>
        </View>;
      })}
      {pending && <View className="gap-3"><View className="max-w-[85%] self-end rounded-2xl rounded-br-md bg-raised px-4 py-2.5 opacity-70"><Text className="text-[15px] text-zinc-100">{pending}</Text></View><ActivityIndicator color="#a1a1aa" /></View>}
    </ScrollView>

    <View className="px-3" style={{ paddingBottom: Math.max(insets.bottom, 10) }}>
      {sendError && <Text className="mb-1.5 text-[12px] text-rose-300">{sendError}</Text>}
      <View className="rounded-2xl border border-line bg-panel">
        <TextInput value={text} onChangeText={setText} multiline placeholder={status === "online" ? "Mensagem para o Chel…" : "Sem conexão com o computador"} placeholderTextColor="#71717a" className="max-h-36 px-4 pb-1 pt-3 text-[15px] text-white" />
        <View className="flex-row items-center justify-between px-2 pb-2">
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 4 }}>
            {picks.map((p) => <Pressable key={p} onPress={() => setForced(p)} className={`flex-row items-center gap-1 rounded-md px-2 py-1 ${forced === p ? "bg-zinc-700" : ""}`}>
              {p === "auto" ? <Text className="text-[11px] text-zinc-300">✦</Text> : <Mark provider={p} size={11} />}
              <Text className={`text-[11px] ${forced === p ? "text-white" : "text-muted"}`}>{p === "auto" ? "Auto" : brand[p].name}</Text>
            </Pressable>)}
          </ScrollView>
          <Pressable disabled={!text.trim() || status !== "online"} onPress={() => void send()} className={`ml-2 h-9 w-9 items-center justify-center rounded-lg ${text.trim() && status === "online" ? "bg-zinc-100" : "bg-zinc-700"}`}><Text className="text-base font-bold text-zinc-900">↑</Text></Pressable>
        </View>
      </View>
    </View>
  </KeyboardAvoidingView>;
}
