import { useRef, useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useChel } from "../src/lib/chel";
import { formatShortCode } from "../src/lib/remote";
import { IconButton, StatusDot } from "../src/components/ui";

export default function Connect() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { connection, status, connectWithCode, connectWithQr, disconnect } = useChel();
  const [code, setCode] = useState("");
  const [name, setName] = useState("Meu Android");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const lock = useRef(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await fn(); router.replace("/"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); lock.current = false; }
    finally { setBusy(false); }
  }
  const ready = code.replace(/^CHEL-/, "").replace(/-/g, "").length === 16;

  return <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} className="flex-1 bg-canvas">
    <ScrollView contentContainerStyle={{ paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
      <View className="mb-6 flex-row items-center"><IconButton label="✕" onPress={() => router.back()} /><Text className="ml-1 text-lg font-semibold text-white">Conectar ao computador</Text></View>

      {connection && <View className="mb-6 rounded-2xl border border-line bg-panel p-4">
        <View className="flex-row items-center gap-2"><StatusDot status={status} /><Text className="text-[14px] text-white">{status === "online" ? "Conectado" : "Salvo, sem resposta agora"}</Text></View>
        <Text className="mt-1 text-[12px] text-muted">{connection.endpoint}</Text>
        <Pressable onPress={() => Alert.alert("Desconectar?", "Você vai precisar de um código novo para voltar.", [{ text: "Cancelar", style: "cancel" }, { text: "Desconectar", style: "destructive", onPress: () => void disconnect() }])} className="mt-3 self-start rounded-lg border border-rose-500/30 px-3 py-2"><Text className="text-[13px] text-rose-300">Desconectar este celular</Text></Pressable>
      </View>}

      <Text className="text-[13px] leading-5 text-muted">No Chel do computador, abra <Text className="text-zinc-200">Usar no celular</Text> → <Text className="text-zinc-200">Ligar e gerar código</Text>, e digite o código aqui.</Text>
      <TextInput value={code} onChangeText={(v) => setCode(formatShortCode(v))} autoCapitalize="characters" autoCorrect={false} placeholder="CHEL-XXXX-XXXX-XXXX-XXXX" placeholderTextColor="#52525b"
        className="mt-4 rounded-xl border border-line bg-panel px-4 py-4 text-center text-[19px] tracking-wider text-white" style={{ fontFamily: "monospace" }} />
      <Text className="mb-1.5 mt-4 text-[12px] text-muted">Nome deste celular</Text>
      <TextInput value={name} onChangeText={setName} placeholderTextColor="#52525b" className="rounded-xl border border-line bg-panel px-4 py-3 text-[15px] text-white" />
      <Pressable disabled={!ready || busy} onPress={() => void run(() => connectWithCode(code, name.trim() || "Android"))} className={`mt-5 items-center rounded-xl py-3.5 ${ready && !busy ? "bg-zinc-100" : "bg-zinc-700"}`}>
        {busy ? <ActivityIndicator color="#18181b" /> : <Text className="font-semibold text-zinc-900">Conectar</Text>}
      </Pressable>
      {error && <Text className="mt-4 rounded-xl bg-rose-500/10 p-3 text-[13px] leading-5 text-rose-200">{error}</Text>}

      <View className="my-7 flex-row items-center gap-3"><View className="h-px flex-1 bg-line" /><Text className="text-[12px] text-muted">ou</Text><View className="h-px flex-1 bg-line" /></View>
      {!scanning ? <Pressable onPress={async () => { if (!permission?.granted) { const r = await requestPermission(); if (!r.granted) { if (!r.canAskAgain) void Linking.openSettings(); return; } } setScanning(true); }} className="items-center rounded-xl border border-line py-3.5"><Text className="text-[14px] text-zinc-200">Ler o QR Code com a câmera</Text></Pressable>
        : <View className="overflow-hidden rounded-xl border border-line"><CameraView style={{ height: 280, width: "100%" }} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={({ data }) => { if (lock.current) return; lock.current = true; setScanning(false); void run(() => connectWithQr(data, name.trim() || "Android")); }} /></View>}
      <Text className="mt-6 text-[11px] leading-5 text-muted">Funciona no mesmo Wi-Fi do computador. Para usar fora de casa, instale o Tailscale no PC e no celular e use o código marcado “Tailscale”. O código vale 3 minutos e serve uma vez.</Text>
    </ScrollView>
  </KeyboardAvoidingView>;
}
