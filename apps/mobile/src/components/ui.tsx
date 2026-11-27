import React from "react";
import { Pressable, Text, View } from "react-native";
import { brand, type ProviderId } from "../lib/chel";

export function Mark({ provider, size = 14 }: { provider: ProviderId; size?: number }) {
  return <Text style={{ color: brand[provider].color, fontSize: size, lineHeight: size * 1.2 }}>{brand[provider].glyph}</Text>;
}

export function Chip({ children, tone = "#d4d4d8" }: { children: React.ReactNode; tone?: string }) {
  return <View className="rounded-md bg-raised px-1.5 py-0.5"><Text style={{ color: tone }} className="text-[11px]">{children}</Text></View>;
}

export function IconButton({ label, onPress }: { label: string; onPress: () => void }) {
  return <Pressable onPress={onPress} hitSlop={10} className="h-9 min-w-9 items-center justify-center rounded-lg px-2 active:bg-raised"><Text className="text-lg text-zinc-300">{label}</Text></Pressable>;
}

export function StatusDot({ status }: { status: string }) {
  const color = status === "online" ? "#34d399" : status === "offline" ? "#f59e0b" : "#71717a";
  return <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }} />;
}

/** Light Markdown: **bold**, `code`, lists and headings, rendered as native text. */
export function Rich({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n");
  return <View className="gap-1.5">{lines.map((line, i) => {
    if (!line.trim()) return <View key={i} className="h-1" />;
    const heading = line.match(/^#{1,4}\s+(.*)/);
    const bullet = line.match(/^\s*([-*•]|\d+[.)])\s+(.*)/);
    const content = heading ? heading[1] : bullet ? bullet[2] : line;
    const parts = content.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((p, k) =>
      p.startsWith("**") ? <Text key={k} className="font-bold text-white">{p.slice(2, -2)}</Text>
        : p.startsWith("`") ? <Text key={k} className="text-violet-200" style={{ fontFamily: "monospace" }}>{p.slice(1, -1)}</Text>
        : p);
    return <View key={i} className={bullet ? "flex-row pl-1" : ""}>
      {bullet ? <Text className="mr-2 text-[15px] text-zinc-500">{/^\d/.test(bullet[1]) ? bullet[1] : "•"}</Text> : null}
      <Text selectable className={`flex-1 text-[15px] leading-6 ${heading ? "font-bold text-white" : "text-zinc-200"}`}>{parts}</Text>
    </View>;
  })}</View>;
}
