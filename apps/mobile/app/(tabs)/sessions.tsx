import { useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { EmptyState, PageHeader, Panel, Pill, Screen } from "../../src/components/ui";
import { useRemote, type ManagedSession } from "../../src/providers/RemoteProvider";

const providers: Record<ManagedSession["provider"], string> = { claude_code: "Claude Code", codex: "Codex App Server", antigravity: "Antigravity" };
const statuses: Record<string, string> = { starting: "Iniciando", running: "Executando", idle: "Ociosa", awaiting_approval: "Aguardando aprovação", interrupted: "Interrompida", disconnected: "Desconectada", stopped: "Encerrada", failed: "Falhou" };
export default function SessionsScreen() {
  const insets = useSafeAreaInsets();
  const { connection, sessions, refresh, resumeSession, sendSessionMessage, stopSession } = useRemote();
  const [prompt, setPrompt] = useState("Continue o trabalho anterior. Verifique o estado atual do workspace e prossiga com a próxima tarefa pendente.");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  async function onRefresh() { setRefreshing(true); try { await refresh(); } finally { setRefreshing(false); } }
  return <Screen><ScrollView className="flex-1 px-5" contentContainerStyle={{ paddingTop: Math.max(insets.top, 16) + 8, paddingBottom: 28 }} refreshControl={<RefreshControl tintColor="#c4b5fd" refreshing={refreshing} onRefresh={() => void onRefresh()} />}>
    <PageHeader eyebrow="SESSION MANAGER" title="Sessões" subtitle="Registro das sessões nativas no computador pareado." />
    {!connection ? <EmptyState title="Conecte um Host" detail="Pareie o aplicativo com o Desktop para consultar as sessões." /> : sessions.length === 0 ? <EmptyState title="Nenhuma sessão registrada" detail="Inicie uma sessão no Desktop para vê-la aqui." /> : <>
    {sessions.some((item) => item.recovery_mode === "native_resume" && item.external_session_id) ? <Panel className="mb-3"><Text className="text-xs font-semibold text-white">Retomar sessões pelo celular</Text><TextInput value={prompt} onChangeText={setPrompt} multiline placeholder="Instrução para continuar" placeholderTextColor="#777" className="mt-2 min-h-20 rounded-lg border border-line bg-canvas p-3 text-xs text-white"/><Text className="mt-2 text-[10px] text-muted">Claude Code e Codex usam seus protocolos nativos de retomada. Antigravity executa um turno headless com as permissões configuradas no próprio CLI.</Text></Panel> : null}
    {sessions.map((session) => <Panel key={session.id} className="mb-3">
      <View className="flex-row items-center justify-between gap-2"><Text className="flex-1 text-sm font-semibold text-white">{providers[session.provider]}</Text><Pill tone={session.status === "running" ? "green" : session.status === "interrupted" ? "amber" : "neutral"}>{statuses[session.status] ?? session.status}</Pill></View>
      <Text numberOfLines={2} className="mt-2 text-[10px] text-muted">{session.cwd}</Text>
      <View className="mt-3 flex-row flex-wrap gap-2"><Pill>{session.model ?? "Modelo padrão"}</Pill><Pill>{session.recovery_mode === "native_resume" ? "Retomada nativa" : "Somente metadados"}</Pill></View>
      <View className="mt-3 rounded-xl border border-line bg-canvas p-3"><Text className="text-[10px] leading-5 text-muted">{session.recovery_note}</Text>{session.external_session_id ? <Text selectable className="mt-2 text-[9px] text-muted">ID: {session.external_session_id}</Text> : null}</View>
      {session.recovery_mode === "native_resume" && session.external_session_id && !["running", "starting"].includes(session.status) ? <Pressable disabled={busyId === session.id || !prompt.trim()} onPress={async () => { setBusyId(session.id); try { const resumedId = await resumeSession(session.id, prompt); Alert.alert("Sessão retomada", `Nova sessão: ${resumedId}`); } catch (error) { Alert.alert("Falha ao retomar", String(error)); } finally { setBusyId(null); } }} className="mt-3 rounded-lg border border-violet-400/30 bg-violet-400/10 px-3 py-3"><Text className="text-center text-xs font-semibold text-violet-200">{busyId === session.id ? "Retomando..." : `Retomar ${session.provider}`}</Text></Pressable> : null}
      {session.status === "running" && session.provider !== "antigravity" ? <View className="mt-3 flex-row gap-2"><Pressable onPress={async () => { if (!prompt.trim()) return; setBusyId(session.id); try { await sendSessionMessage(session.id, prompt); setPrompt(""); Alert.alert("Mensagem enviada"); } catch (error) { Alert.alert("Falha ao enviar", String(error)); } finally { setBusyId(null); } }} disabled={busyId === session.id || !prompt.trim()} className="flex-1 rounded-lg border border-sky-400/30 bg-sky-400/10 px-3 py-3"><Text className="text-center text-xs font-semibold text-sky-200">Enviar mensagem</Text></Pressable><Pressable onPress={async () => { setBusyId(session.id); try { await stopSession(session.id); Alert.alert("Sessão interrompida"); } catch (error) { Alert.alert("Falha ao interromper", String(error)); } finally { setBusyId(null); } }} className="rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-3"><Text className="text-xs font-semibold text-rose-200">Parar</Text></Pressable></View> : null}
    </Panel>)}
    </>}
  </ScrollView></Screen>;
}
