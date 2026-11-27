import { Tabs } from "expo-router";
import { Text } from "react-native";

export default function TabsLayout() {
  return <Tabs screenOptions={{
    headerShown: false,
    tabBarStyle: { backgroundColor: "#111116", borderTopColor: "#27272f", height: 66, paddingTop: 7, paddingBottom: 8 },
    tabBarActiveTintColor: "#c4b5fd",
    tabBarInactiveTintColor: "#71717a",
    tabBarLabelStyle: { fontSize: 9, fontWeight: "600" },
  }}>
    <Tabs.Screen name="index" options={{ title: "Painel", tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 20 }}>⌂</Text> }} />
    <Tabs.Screen name="prompt" options={{ title: "Novo", tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 22 }}>+</Text> }} />
    <Tabs.Screen name="workflows" options={{ title: "Fluxos", tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 20 }}>◇</Text> }} />
    <Tabs.Screen name="providers" options={{ title: "CLIs", tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 18 }}>⌘</Text> }} />
    <Tabs.Screen name="sessions" options={{ title: "Sessões", tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 18 }}>◷</Text> }} />
    <Tabs.Screen name="approvals" options={{ title: "Aprovações", tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 18 }}>✓</Text> }} />
    <Tabs.Screen name="usage" options={{ title: "Usage", tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 18 }}>▥</Text> }} />
  </Tabs>;
}
