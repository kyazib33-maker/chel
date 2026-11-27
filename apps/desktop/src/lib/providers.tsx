import type { ProviderId } from "./tauri";

/** Visual identity for each AI provider: name, accent color and a simple mark. */
export const brand: Record<ProviderId, { name: string; color: string; soft: string; ink: string }> = {
  claude_code: { name: "Claude", color: "#D97757", soft: "rgba(217,119,87,0.12)", ink: "#1a0f0a" },
  codex: { name: "Codex", color: "#F4F4F5", soft: "rgba(244,244,245,0.08)", ink: "#0a0a0a" },
  antigravity: { name: "Antigravity", color: "#4285F4", soft: "rgba(66,133,244,0.12)", ink: "#06101f" },
};

export const effortName: Record<string, string> = { low: "baixo", medium: "médio", high: "alto", xhigh: "muito alto", max: "máximo" };

/** Simple geometric marks (not official logos): sunburst for Claude, hex for Codex, orbit for Antigravity. */
export function ProviderMark({ provider, size = 18 }: { provider: ProviderId; size?: number }) {
  const { color } = brand[provider];
  if (provider === "claude_code") {
    return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>{Array.from({ length: 8 }, (_, i) => <rect key={i} x="11" y="2" width="2" height="9" rx="1" fill={color} transform={`rotate(${i * 45} 12 12)`} />)}</svg>;
  }
  if (provider === "codex") {
    return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden><path d="M12 2.5 20.2 7.25v9.5L12 21.5 3.8 16.75v-9.5z" fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" /><path d="M9 10l-2 2 2 2M15 10l2 2-2 2" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden><ellipse cx="12" cy="12" rx="10" ry="4.5" fill="none" stroke={color} strokeWidth="1.8" transform="rotate(-30 12 12)" /><circle cx="12" cy="12" r="3.5" fill={color} /></svg>;
}
