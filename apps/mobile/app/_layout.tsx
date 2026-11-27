import "../global.css";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ChelProvider } from "../src/lib/chel";

export default function RootLayout() {
  return <SafeAreaProvider>
    <ChelProvider>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "#0d0d10" }, animation: "slide_from_right" }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="chat/[id]" />
        <Stack.Screen name="activity" />
        <Stack.Screen name="connect" options={{ presentation: "modal", animation: "slide_from_bottom" }} />
      </Stack>
    </ChelProvider>
  </SafeAreaProvider>;
}
