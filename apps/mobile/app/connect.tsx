import { useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, Linking, Platform, ScrollView, Text, TextInput, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ActionButton, Field, PageHeader, Panel, Pill, Screen } from "../src/components/ui";
import { useRemote } from "../src/providers/RemoteProvider";

export default function ConnectScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { connection, connectionStatus, pairHost, disconnect } = useRemote();
  const [permission, requestPermission] = useCameraPermissions();
  const [payload, setPayload] = useState("");
  const [deviceName, setDeviceName] = useState(Platform.OS === "ios" ? "iPhone Remote" : "Android Remote");
  const [pairing, setPairing] = useState(false);
  const [scanned, setScanned] = useState(false);
  const scanLockRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  async function pair(value = payload): Promise<boolean> {
    setError(null);
    if (!value.trim()) { setError("Escaneie o QR Code do Desktop ou cole o conteúdo do QR."); return false; }
    setPairing(true);
    try {
      await pairHost(value.trim(), deviceName.trim() || "Mobile Remote");
      Alert.alert("Dispositivo pareado", "Este celular agora está autorizado a controlar o Host.", [{ text: "Continuar", onPress: () => router.back() }]);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setScanned(false);
      return false;
    } finally { setPairing(false); }
  }

  async function handleScan(data: string) {
    if (scanLockRef.current || scanned || pairing) return;
    scanLockRef.current = true;
    setScanned(true);
    setPayload(data);
    const succeeded = await pair(data);
    if (!succeeded) scanLockRef.current = false;
  }

  async function removeConnection() {
    Alert.alert("Desconectar computador?", "O token salvo neste dispositivo será apagado. O Host continuará ligado.", [
      { text: "Cancelar", style: "cancel" },
      { text: "Desconectar", style: "destructive", onPress: () => { void disconnect(); } },
    ]);
  }

  return <Screen>
    <KeyboardAvoidingView className="flex-1" behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView className="flex-1 px-5" contentContainerStyle={{ paddingTop: Math.max(insets.top, 16) + 12, paddingBottom: 30 }} keyboardShouldPersistTaps="handled">
        <PageHeader eyebrow="PAIRING" title="Conectar computador" subtitle="No Desktop, habilite a rede local e gere um QR de pareamento." action={<Text onPress={() => router.back()} className="rounded-lg border border-line px-3 py-2 text-xs text-zinc-300">Fechar</Text>} />
        {connection ? <Panel className="mb-4">
          <View className="flex-row items-center justify-between"><Text className="text-xs font-semibold text-white">Host salvo</Text><Pill tone={connectionStatus === "connected" ? "green" : "amber"}>{connectionStatus === "connected" ? "Online" : "Reconectando"}</Pill></View>
          <Text className="mt-2 text-sm text-zinc-200">{connection.endpoint}</Text>
          <Text className="mt-1 text-[10px] text-muted">ID do dispositivo: {connection.device_id.slice(0, 12)}</Text>
          <View className="mt-4"><ActionButton title="Remover pareamento" variant="danger" onPress={() => removeConnection()} /></View>
        </Panel> : null}

        <Panel className="mb-4">
          <Text className="mb-3 text-xs font-semibold text-white">1. Escanear QR Code</Text>
          {permission?.granted ? <View className="overflow-hidden rounded-xl border border-line bg-black">
            <CameraView style={{ height: 270, width: "100%" }} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={scanned ? undefined : ({ data }) => { void handleScan(data); }} />
          </View> : <View className="items-center rounded-xl border border-line bg-canvas px-4 py-8">
            <Text className="text-center text-xs font-semibold text-zinc-200">A câmera é necessária para ler o código.</Text>
            <Text className="mt-2 text-center text-[10px] leading-5 text-muted">A permissão será usada apenas para capturar o QR de pareamento.</Text>
            <View className="mt-4 w-full"><ActionButton title={permission?.canAskAgain === false ? "Permitir câmera nas configurações" : "Permitir câmera"} onPress={() => permission?.canAskAgain ? void requestPermission() : void Linking.openSettings()} /></View>
          </View>}
          {scanned ? <View className="mt-3"><ActionButton title="Escanear novamente" variant="secondary" onPress={() => { scanLockRef.current = false; setScanned(false); setPayload(""); setError(null); }} /></View> : null}
        </Panel>

        <Panel className="mb-4 gap-4">
          <Text className="text-xs font-semibold text-white">2. Identificar este dispositivo</Text>
          <Field label="Nome do dispositivo" value={deviceName} onChangeText={setDeviceName} placeholder="Ex.: Meu celular" />
          <Text className="text-[10px] font-semibold uppercase tracking-widest text-muted">Alternativa: colar payload do QR</Text>
          <TextInput value={payload} onChangeText={setPayload} multiline numberOfLines={4} textAlignVertical="top" autoCapitalize="none" autoCorrect={false} placeholder="Cole o conteúdo JSON do QR Code..." placeholderTextColor="#71717a" className="min-h-24 rounded-xl border border-line bg-canvas p-3 text-[10px] leading-5 text-zinc-200" />
          <ActionButton title="Parear com este Host" onPress={() => void pair()} loading={pairing} disabled={!payload.trim()} />
        </Panel>

        {error ? <View className="rounded-xl border border-rose-500/20 bg-rose-500/10 p-3"><Text className="text-xs leading-5 text-rose-300">{error}</Text></View> : null}
        <Text className="mt-2 text-[9px] leading-5 text-muted">O pareamento é de uso único e expira após 180 segundos. O token do dispositivo é armazenado no SecureStore. Não compartilhe o QR nem o conteúdo JSON com terceiros.</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  </Screen>;
}
