import React from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View, type TextInputProps, type ViewProps } from "react-native";

export function Screen({ children, className = "", ...props }: ViewProps & { className?: string }) {
  return <View className={`flex-1 bg-canvas ${className}`} {...props}>{children}</View>;
}

export function PageHeader({ eyebrow, title, subtitle, action }: { eyebrow?: string; title: string; subtitle?: string; action?: React.ReactNode }) {
  return <View className="mb-5 flex-row items-start justify-between gap-3">
    <View className="min-w-0 flex-1">
      {eyebrow ? <Text className="text-[10px] font-bold uppercase tracking-[2.5px] text-accent">{eyebrow}</Text> : null}
      <Text className="mt-1 text-2xl font-bold text-white">{title}</Text>
      {subtitle ? <Text className="mt-1 text-xs leading-5 text-muted">{subtitle}</Text> : null}
    </View>
    {action}
  </View>;
}

export function Panel({ children, className = "", ...props }: ViewProps & { className?: string }) {
  return <View className={`rounded-2xl border border-line bg-panel p-4 ${className}`} {...props}>{children}</View>;
}

export function Label({ children }: { children: React.ReactNode }) {
  return <Text className="mb-2 text-[10px] font-semibold uppercase tracking-[1.4px] text-muted">{children}</Text>;
}

export function Field({ label, className = "", ...props }: TextInputProps & { label: string; className?: string }) {
  return <View className={className}><Label>{label}</Label><TextInput placeholderTextColor="#71717a" className="rounded-xl border border-line bg-canvas px-3.5 py-3 text-sm text-white" {...props} /></View>;
}

export function ActionButton({ title, onPress, variant = "primary", disabled, loading }: { title: string; onPress: () => void; variant?: "primary" | "secondary" | "danger"; disabled?: boolean; loading?: boolean }) {
  const style = variant === "primary" ? "bg-accent" : variant === "danger" ? "border border-rose-400/30 bg-rose-400/10" : "border border-line bg-panel";
  const text = variant === "primary" ? "text-[#100d19]" : variant === "danger" ? "text-rose-300" : "text-zinc-200";
  return <Pressable onPress={onPress} disabled={disabled || loading} className={`min-h-11 flex-row items-center justify-center rounded-xl px-4 py-3 ${style} ${(disabled || loading) ? "opacity-40" : ""}`}>
    {loading ? <ActivityIndicator size="small" color={variant === "primary" ? "#100d19" : "#c4b5fd"} /> : <Text className={`text-xs font-bold ${text}`}>{title}</Text>}
  </Pressable>;
}

export function Pill({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "green" | "amber" | "red" | "purple" | "blue" }) {
  const toneClass = { neutral: "border-line bg-canvas text-zinc-400", green: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300", amber: "border-amber-500/20 bg-amber-500/10 text-amber-300", red: "border-rose-500/20 bg-rose-500/10 text-rose-300", purple: "border-violet-500/20 bg-violet-500/10 text-violet-300", blue: "border-sky-500/20 bg-sky-500/10 text-sky-300" }[tone];
  return <View className={`self-start rounded-full border px-2.5 py-1 ${toneClass}`}><Text className="text-[9px] font-semibold">{children}</Text></View>;
}

export function EmptyState({ title, detail, action }: { title: string; detail: string; action?: React.ReactNode }) {
  return <Panel className="items-center py-8">
    <View className="mb-3 h-10 w-10 items-center justify-center rounded-full border border-line bg-canvas"><Text className="text-lg text-accent">◇</Text></View>
    <Text className="text-sm font-semibold text-zinc-100">{title}</Text>
    <Text className="mt-2 max-w-[280px] text-center text-xs leading-5 text-muted">{detail}</Text>
    {action ? <View className="mt-4 w-full">{action}</View> : null}
  </Panel>;
}

export function formatTokens(value: number) {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}
