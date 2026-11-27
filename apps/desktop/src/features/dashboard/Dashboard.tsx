import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw } from "lucide-react";
import { desktopBridgeAvailable, getUsageSnapshot, type ProviderId, type UsageSnapshot } from "../../lib/tauri";
import { brand, ProviderMark } from "../../lib/providers";

type Capability = { provider: string; display_name: string; launch: boolean };
const order: ProviderId[] = ["claude_code", "codex", "antigravity"];
const status: Record<string, { label: string; tone: string }> = {
  normal: { label: "Disponível", tone: "text-emerald-300" },
  rate_limited: { label: "Limite temporário atingido", tone: "text-amber-300" },
  quota_exceeded: { label: "Cota esgotada", tone: "text-rose-300" },
  unknown: { label: "Limite não informado", tone: "text-slate-400" },
};
const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} mi` : n >= 1000 ? `${(n / 1000).toFixed(1)} mil` : String(n);

export default function Dashboard() {
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [caps, setCaps] = useState<Capability[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    if (!desktopBridgeAvailable) return;
    setLoading(true); setError(null);
    try {
      const [u, c] = await Promise.all([getUsageSnapshot(), invoke<Capability[]>("list_provider_capabilities")]);
      setUsage(u); setCaps(c);
    } catch (reason) { setError(String(reason)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  return <div className="mx-auto max-w-5xl">
    <div className="mb-6 flex items-center justify-between"><div><h1 className="text-lg font-semibold">Painel</h1><p className="text-sm text-muted">Suas IAs e quanto ainda dá para usar de cada uma.</p></div><button onClick={() => void load()} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-xs hover:bg-panel"><RefreshCw size={13} className={loading ? "animate-spin" : ""} />Atualizar</button></div>
    {!desktopBridgeAvailable && <p className="mb-4 text-sm text-amber-300">Abra pelo app instalado para ver os dados.</p>}
    {error && <p className="mb-4 text-sm text-rose-300">{error}</p>}
    <div className="grid gap-4 md:grid-cols-3">
      {order.map((id) => {
        const b = brand[id];
        const u = usage?.providers.find((p) => p.provider === id);
        const installed = caps.find((c) => c.provider === id)?.launch ?? null;
        const s = status[u?.quota_status ?? "unknown"];
        const used = u ? u.historical.input_tokens + u.historical.output_tokens + u.live.input_tokens + u.live.output_tokens : 0;
        return <div key={id} className="rounded-2xl border p-5" style={{ borderColor: b.color + "55", background: b.soft }}>
          <div className="flex items-center gap-3"><ProviderMark provider={id} size={26} /><h2 className="text-base font-semibold" style={{ color: b.color }}>{b.name}</h2></div>
          <p className={`mt-4 text-sm font-medium ${s.tone}`}>{s.label}</p>
          <dl className="mt-4 space-y-2 text-xs">
            <div className="flex justify-between"><dt className="text-muted">Instalado</dt><dd>{installed === null ? "—" : installed ? "Sim" : "Não"}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Tokens usados</dt><dd>{u ? fmt(used) : "—"}</dd></div>
            <div className="flex justify-between"><dt className="text-muted">Sessões</dt><dd>{u ? u.sessions_scanned : "—"}</dd></div>
          </dl>
          {u && !u.official_quota_available && <p className="mt-4 text-[11px] text-muted">Esta IA não informa o limite exato; o status vem dos últimos erros.</p>}
        </div>;
      })}
    </div>
  </div>;
}
