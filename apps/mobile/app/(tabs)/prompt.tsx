import { useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { AgentLaunchRequest, ProviderId } from "@orchestrator/shared-types";
import { ActionButton, Field, Label, PageHeader, Panel, Pill, Screen } from "../../src/components/ui";
import { useRemote } from "../../src/providers/RemoteProvider";

const providers: { id: ProviderId; label: string }[] = [
  { id: "claude_code", label: "Claude Code" },
  { id: "codex", label: "Codex CLI" },
  { id: "antigravity", label: "Antigravity" },
];
const efforts: Record<ProviderId, string[]> = {
  claude_code: ["low", "medium", "high", "max"],
  codex: ["low", "medium", "high", "xhigh"],
  antigravity: ["low", "medium", "high"],
};
function ChoiceRow({ items, value, onChange }: { items: string[]; value: string; onChange: (value: string) => void }) {
  return <View className="flex-row flex-wrap gap-2">{items.map((item) => <Text key={item} onPress={() => onChange(item)} className={`rounded-full border px-3 py-2 text-[10px] font-semibold ${value === item ? "border-violet-300/40 bg-violet-300/10 text-violet-200" : "border-line bg-panel text-zinc-400"}`}>{item}</Text>)}</View>;
}

export default function PromptScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { connection, launchTask } = useRemote();
  const [provider, setProvider] = useState<ProviderId>("claude_code");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("medium");
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("Tarefa remota");
  const [busy, setBusy] = useState(false);

  function changeProvider(next: ProviderId) {
    setProvider(next);
    setModel("");
    setEffort("medium");
  }

  async function submit() {
    if (!connection) { Alert.alert("Desktop não conectado", "Pareie o aplicativo com o Psylium Desktop primeiro."); return; }
    if (!cwd.trim()) { Alert.alert("Pasta obrigatória", "Informe o caminho absoluto de um projeto existente no computador Host."); return; }
    if (!prompt.trim()) { Alert.alert("Prompt vazio", "Descreva o que o agente deve fazer."); return; }
    const request: AgentLaunchRequest = {
      provider, prompt: prompt.trim(), cwd: cwd.trim(),
      model: model.trim() ? model.trim() : null,
      effort: effort === "medium" ? null : effort,
      display_name: name.trim() || undefined,
    };
    setBusy(true);
    try {
      const id = await launchTask(request);
      setPrompt("");
      Alert.alert("Tarefa enviada", `A execução ${id.slice(0, 8)} foi adicionada ao Host.`, [{ text: "Acompanhar", onPress: () => router.push({ pathname: "/task/[id]", params: { id } }) }, { text: "OK" }]);
    } catch (error) {
      Alert.alert("Falha ao iniciar", error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  }

  return <Screen>
    <KeyboardAvoidingView className="flex-1" behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView className="flex-1 px-5" contentContainerStyle={{ paddingTop: Math.max(insets.top, 16) + 8, paddingBottom: 36 }} keyboardShouldPersistTaps="handled">
        <PageHeader eyebrow="DISPATCH" title="Novo agente" subtitle="Envie uma tarefa para os CLIs autenticados no computador." />
        {!connection ? <Panel className="mb-4"><Text className="text-xs leading-5 text-amber-200">Nenhum Desktop pareado. Conecte um Host antes de disparar tarefas.</Text></Panel> : <View className="mb-4 flex-row items-center gap-2"><Pill tone="green">Host conectado</Pill><Text className="text-[10px] text-muted">{new URL(connection.endpoint).host}</Text></View>}

        <Panel className="mb-3">
          <Label>Provedor</Label>
          <View className="gap-2">{providers.map((item) => <Text key={item.id} onPress={() => changeProvider(item.id)} className={`rounded-xl border px-3.5 py-3 text-xs font-semibold ${provider === item.id ? "border-violet-300/40 bg-violet-300/10 text-violet-100" : "border-line bg-canvas text-zinc-400"}`}>{item.label}</Text>)}</View>
          <View className="mt-4"><Field label="Modelo (opcional)" value={model} onChangeText={setModel} placeholder="Deixe vazio para usar o padrão do CLI" autoCapitalize="none" autoCorrect={false} /></View>
          <View className="mt-4"><Label>Esforço</Label><ChoiceRow items={efforts[provider]} value={effort} onChange={setEffort} /></View>
        </Panel>

        <Panel className="mb-3 gap-4">
          <Field label="Nome da tarefa" value={name} onChangeText={setName} placeholder="Ex.: Implementar autenticação" />
          <Field label="Pasta de trabalho no Host" value={cwd} onChangeText={setCwd} placeholder={Platform.OS === "windows" ? "C:\\Users\\Você\\Projetos\\app" : "/home/usuario/projetos/app"} autoCapitalize="none" autoCorrect={false} />
          <Field label="Prompt" value={prompt} onChangeText={setPrompt} placeholder="Descreva a tarefa, contexto e critérios de aceitação..." multiline numberOfLines={8} textAlignVertical="top" style={{ minHeight: 150 }} />
        </Panel>

        <View className="mb-4 rounded-xl border border-line bg-panel p-3"><Text className="text-[10px] leading-5 text-muted">A pasta precisa existir no computador e estar dentro da raiz autorizada para acesso remoto. O Host executa o CLI local usando a sessão já autenticada; nenhuma chave de API é solicitada.</Text></View>
        <ActionButton title="Enviar tarefa ao Desktop" onPress={() => void submit()} disabled={!connection || !prompt.trim() || !cwd.trim()} loading={busy} />
      </ScrollView>
    </KeyboardAvoidingView>
  </Screen>;
}
