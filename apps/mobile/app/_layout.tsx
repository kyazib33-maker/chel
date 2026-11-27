import "../global.css";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { RemoteProvider } from "../src/providers/RemoteProvider";

export default function RootLayout() {
  return <SafeAreaProvider>
    <RemoteProvider>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "#09090b" } }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="connect" options={{ presentation: "modal", animation: "slide_from_bottom" }} />
        <Stack.Screen name="task/[id]" options={{ presentation: "card", animation: "slide_from_right" }} />
      </Stack>
    </RemoteProvider>
  </SafeAreaProvider>;
}
