import { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Keyboard, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { brand, effortName, finished, parseChoices, useChel, type ProviderId, type Turn } from "../../src/lib/chel";
import { Chip, IconButton, Mark, Rich } from "../../src/components/ui";

const picks: Array<ProviderId | "auto"> = ["auto", "claude_code", "codex", "antigravity"];
type Row = { kind: "turn"; turn: Turn; last: boolean } | { kind: "pending"; prompt: string };

/** Height of the on-screen keyboard (Android draws edge-to-edge, so the screen does not shrink by itself). */
function useKeyboardHeight() {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", (e) => setHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () => setHeight(0));
    return () => { show.remove(); hide.remove(); };
  }, []);
  return height;
}

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const keyboard = useKeyboardHeight();
  const { state, command, status } = useChel();
  const chat = state.chats.find((c) => c.id === id);
  const [text, setText] = useState("");
  const [forced, setForced] = useState<ProviderId | "auto">("auto");
  const [pending, setPending] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [openSteps, setOpenSteps] = useState<Record<string, boolean>>({});
  const turns = chat?.turns ?? [];
  const busy = turns.some((t) => t.status && !finished.includes(t.status) && !t.error);

  useEffect(() => { if (pending && turns.some((t) => t.prompt === pending)) setPending(null); }, [turns, pending]);

  async function send(prompt = text.trim(), provider: ProviderId | "auto" = forced) {
    if (!prompt) return;
    if (prompt === text.trim()) setText("");
    setPending(prompt); setSendError(null);
    try { await command({ type: "send", chat_id: id, prompt, provider, title: chat ? undefined : prompt.slice(0, 42) }); }
    catch (reason) { setPending(null); setText(prompt); setSendError(reason instanceof Error ? reason.message : String(reason)); }
  }

  // Inverted list: newest at the bottom, the view stays anchored there and never jumps when answers update.
  const rows: Row[] = [
    ...(pending ? [{ kind: "pending", prompt: pending } as Row] : []),
    ...[...turns].reverse().map((t, i) => ({ kind: "turn", turn: t, last: i === 0 } as Row)),
  ];

  const renderTurn = (t: Turn, last: boolean) => {
    const b = t.provider ? brand[t.provider] : null;
    const running = !!t.status && !finished.includes(t.status) && !t.error;
    const choices = t.answer ? parseChoices(t.answer) : null;
    const steps = t.steps ?? [];
    return <View style={{ gap: 12, marginBottom: 22 }}>
      <View className="max-w-[85%] self-end rounded-2xl rounded-br-md bg-raised px-4 py-2.5"><Text selectable style={{ color: "#f4f4f5", fontSize: 15, lineHeight: 22 }}>{t.prompt}</Text></View>
      <View style={{ gap: 6 }}>
        <View className="flex-row flex-wrap items-center gap-1.5">
          {t.provider && b ? <><Mark provider={t.provider} /><Text style={{ color: b.color, fontSize: 13, fontWeight: "600" }}>{b.name}</Text></> : <Text style={{ color: "#86868f", fontSize: 12 }}>Escolhendo a IA…</Text>}
          {t.model ? <Chip>{t.model}</Chip> : null}
          {t.effort ? <Chip tone="#a1a1aa">esforço {effortName[t.effort] ?? t.effort}</Chip> : null}
          {running ? <ActivityIndicator size="small" color={b?.color ?? "#a1a1aa"} /> : null}
        </View>
        {t.notes.map((n, i) => <Text key={i} style={{ color: "#fcd34d", fontSize: 12 }}>{n}</Text>)}
        {steps.length > 0 && <Pressable onPress={() => setOpenSteps((o) => ({ ...o, [t.id]: !o[t.id] }))}>
          <Text style={{ color: "#86868f", fontSize: 12 }}>{openSteps[t.id] ? "▾" : "▸"} {steps.length} etapa(s) intermediária(s)</Text>
          {openSteps[t.id] && <View style={{ borderLeftWidth: 1, borderLeftColor: "#25252c", paddingLeft: 10, marginTop: 4, gap: 4 }}>{steps.map((s, i) => <Text key={i} style={{ color: "#86868f", fontSize: 12 }}>{s}</Text>)}</View>}
        </Pressable>}
        {t.error ? <Text style={{ color: "#fda4af", fontSize: 15 }}>Não deu certo: {t.error}</Text>
          : t.answer ? <Rich text={choices ? choices.text : t.answer} />
          : running ? <Text style={{ color: "#86868f", fontSize: 14 }}>Trabalhando…</Text>
          : t.status && finished.includes(t.status) ? <Text style={{ color: "#86868f", fontSize: 14 }}>A IA terminou sem enviar resposta em texto.</Text> : null}
        {choices && <View className="mt-1 rounded-xl border border-line bg-panel p-3" style={{ gap: 6 }}>
          {choices.question ? <Text style={{ color: "#e4e4e7", fontSize: 14, fontWeight: "600", marginBottom: 2 }}>{choices.question}</Text> : null}
          {choices.options.map((o) => <Pressable key={o} disabled={!last || busy} onPress={() => void send(o, "auto")} className="rounded-lg border border-line bg-raised px-3 py-2.5 active:opacity-70" style={{ opacity: !last || busy ? 0.5 : 1 }}><Text style={{ color: "#e4e4e7", fontSize: 14 }}>{o}</Text></Pressable>)}
        </View>}
        {t.denials && t.denials.length > 0 && <View className="mt-1 rounded-xl border p-3" style={{ borderColor: "rgba(245,158,11,0.35)", backgroundColor: "rgba(245,158,11,0.06)", gap: 4 }}>
          <Text style={{ color: "#fde68a", fontSize: 13, fontWeight: "600" }}>A IA precisou de permissão para:</Text>
          {t.denials.map((d, i) => <Text key={i} numberOfLines={1} style={{ color: "#d4d4d8", fontSize: 12 }}>• {d.dir ? `abrir ${d.dir}` : `usar ${d.tool}${d.target ? `: ${d.target}` : ""}`}</Text>)}
          {t.retried ? <Text style={{ color: "#6ee7b7", fontSize: 12, marginTop: 4 }}>Permitido nesta conversa.</Text>
            : <Pressable onPress={() => void command({ type: "allow_retry", chat_id: id, turn_id: t.id })} className="mt-2 self-start rounded-lg bg-zinc-100 px-3 py-2 active:opacity-80"><Text style={{ color: "#18181b", fontSize: 13, fontWeight: "700" }}>Permitir e repetir</Text></Pressable>}
        </View>}
        {t.status === "awaiting_approval" ? <Text style={{ color: "#c4b5fd", fontSize: 12 }}>A IA está pedindo permissão — aprove no computador.</Text> : null}
        {running && t.task_id ? <Pressable onPress={() => void command({ type: "cancel", task_id: t.task_id })} className="mt-1 self-start rounded-md px-2 py-1 active:bg-raised"><Text style={{ color: "#86868f", fontSize: 12 }}>■ Parar</Text></Pressable> : null}
      </View>
    </View>;
  };

  return <View className="flex-1 bg-canvas" style={{ paddingTop: insets.top, paddingBottom: keyboard }}>
    <View className="flex-row items-center gap-1 border-b border-line px-2 pb-2 pt-2">
      <IconButton label="‹" onPress={() => router.back()} />
      <Text numberOfLines={1} className="flex-1 text-[15px] font-medium text-white">{chat?.title ?? "Nova conversa"}</Text>
      <IconButton label="⚡" onPress={() => router.push("/activity")} />
    </View>

    {rows.length === 0 ? <View className="flex-1 items-center justify-center px-8">
      <View className="flex-row gap-3">{(["claude_code", "codex", "antigravity"] as ProviderId[]).map((p) => <Mark key={p} provider={p} size={22} />)}</View>
      <Text className="mt-4 text-xl font-semibold text-white">Como posso ajudar?</Text>
      <Text className="mt-2 text-center text-[13px] leading-5 text-muted">O Chel escolhe a IA, o modelo e o esforço, sempre gastando pouco. Para escolher você, diga “usa o Codex” ou toque numa IA abaixo.</Text>
    </View>
      : <FlatList inverted data={rows} keyboardShouldPersistTaps="handled" keyExtractor={(r) => r.kind === "turn" ? r.turn.id : "pending"} contentContainerStyle={{ padding: 16 }}
        renderItem={({ item }) => item.kind === "turn" ? renderTurn(item.turn, item.last)
          : <View style={{ gap: 12, marginBottom: 22 }}><View className="max-w-[85%] self-end rounded-2xl rounded-br-md bg-raised px-4 py-2.5" style={{ opacity: 0.7 }}><Text style={{ color: "#f4f4f5", fontSize: 15 }}>{item.prompt}</Text></View><ActivityIndicator color="#a1a1aa" /></View>} />}

    <View className="px-3" style={{ paddingBottom: keyboard ? 8 : Math.max(insets.bottom, 10) }}>
      {sendError && <Text style={{ color: "#fda4af", fontSize: 12, marginBottom: 6 }}>{sendError}</Text>}
      <View className="rounded-2xl border border-line bg-panel">
        <TextInput value={text} onChangeText={setText} multiline placeholder={status === "online" ? "Mensagem para o Chel…" : "Sem conexão com o computador"} placeholderTextColor="#71717a" style={{ color: "#ffffff", fontSize: 15, maxHeight: 144, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 }} />
        <View className="flex-row items-center justify-between px-2 pb-2">
          <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 4 }}>
            {picks.map((p) => <Pressable key={p} onPress={() => setForced(p)} className={`flex-row items-center gap-1 rounded-md px-2 py-1 ${forced === p ? "bg-zinc-700" : ""}`}>
              {p === "auto" ? <Text style={{ color: "#d4d4d8", fontSize: 11 }}>✦</Text> : <Mark provider={p} size={11} />}
              <Text style={{ color: forced === p ? "#ffffff" : "#86868f", fontSize: 11 }}>{p === "auto" ? "Auto" : brand[p].name}</Text>
            </Pressable>)}
          </ScrollView>
          <Pressable disabled={!text.trim() || status !== "online"} onPress={() => void send()} className={`ml-2 h-9 w-9 items-center justify-center rounded-lg ${text.trim() && status === "online" ? "bg-zinc-100" : "bg-zinc-700"}`}><Text style={{ color: "#18181b", fontSize: 16, fontWeight: "700" }}>↑</Text></Pressable>
        </View>
      </View>
    </View>
  </View>;
}
