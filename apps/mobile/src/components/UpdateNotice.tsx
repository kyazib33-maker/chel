import { useEffect, useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import Constants from "expo-constants";

const RELEASES = "https://api.github.com/repos/kyazib33-maker/chel/releases/latest";

function newer(a: string, b: string) {
  const pa = a.replace(/^v/, "").split(".").map(Number); const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0); }
  return false;
}

/** Looks at the latest Chel release on GitHub and offers the new APK when there is one. */
export function UpdateNotice() {
  const [update, setUpdate] = useState<{ version: string; url: string } | null>(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const current = Constants.expoConfig?.version ?? "0.0.0";
    fetch(RELEASES, { headers: { Accept: "application/vnd.github+json" } })
      .then((r) => r.ok ? r.json() : null)
      .then((rel) => {
        const apk = rel?.assets?.find((a: { name: string }) => a.name.endsWith(".apk"));
        if (rel?.tag_name && apk && newer(rel.tag_name, current)) setUpdate({ version: rel.tag_name.replace(/^v/, ""), url: apk.browser_download_url });
      })
      .catch(() => undefined);
  }, []);
  if (!update || hidden) return null;
  return <View className="mx-4 mb-2 flex-row items-center gap-3 rounded-xl border border-line bg-panel px-3 py-2.5">
    <View className="flex-1"><Text style={{ color: "#f4f4f5", fontSize: 13, fontWeight: "600" }}>Nova versão do Chel: {update.version}</Text><Text style={{ color: "#86868f", fontSize: 11 }}>Baixe e instale por cima da atual.</Text></View>
    <Pressable onPress={() => void Linking.openURL(update.url)} className="rounded-lg bg-zinc-100 px-3 py-2 active:opacity-80"><Text style={{ color: "#18181b", fontSize: 12, fontWeight: "700" }}>Baixar</Text></Pressable>
    <Pressable onPress={() => setHidden(true)} hitSlop={8}><Text style={{ color: "#86868f", fontSize: 14 }}>✕</Text></Pressable>
  </View>;
}
