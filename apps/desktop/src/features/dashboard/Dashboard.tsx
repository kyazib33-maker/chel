import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { desktopBridgeAvailable, readQuotas, type ProviderId, type ProviderQuota } from "../../lib/tauri";
import { brand, ProviderMark } from "../../lib/providers";

const order: ProviderId[] = ["claude_code", "codex", "antigravity"];

/** "2026-12-03T10:28:05Z" → "3 dez, 07:28"; other text (e.g. "Nov 27, 2:29am (...)") is shown without the time zone. */
function when(resets: string | null): string {
  if (!resets) return "";
  const d = new Date(resets);
  if (!Number.isNaN(d.getTime()) && /^\d{4}-/.test(resets)) return d.toLocaleString("pt-BR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return resets.replace(/\s*\(.*\)$/, "");
}

function barColor(pct: number) { return pct <= 0 ? "#f43f5e" : pct < 20 ? "#f59e0b" : "#34d399"; }

export default function Dashboard() {
  const [quotas, setQuotas] = useState<ProviderQuota[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    if (!desktopBridgeAvailable) return;
    setLoading(true); setError(null);
    try { setQuotas(await readQuotas()); }
    catch (reason) { setError(String(reason)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  return <div className="mx-auto max-w-5xl">
    <div className="mb-6 flex items-center justify-between"><div><h1 className="text-lg font-semibold">Painel</h1><p className="text-sm text-muted">Quanto ainda resta de cada IA. A leitura não gasta tokens.</p></div><button disabled={loading} onClick={() => void load()} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-xs hover:bg-panel disabled:opacity-50"><RefreshCw size={13} className={loading ? "animate-spin" : ""} />{loading ? "Lendo…" : "Atualizar"}</button></div>
    {!desktopBridgeAvailable && <p className="mb-4 text-sm text-amber-300">Abra pelo app instalado para ver os limites.</p>}
    {error && <p className="mb-4 text-sm text-rose-300">{error}</p>}
    <div className="grid gap-4 md:grid-cols-3">
      {order.map((id) => {
        const b = brand[id];
        const q = quotas?.find((x) => x.provider === id);
        const state = !q ? (loading ? "Lendo…" : "—") : q.error ? "Não foi possível ler" : q.available ? "Disponível" : "Sem cota agora";
        const tone = !q || q.error ? "text-slate-400" : q.available ? "text-emerald-300" : "text-rose-300";
        return <div key={id} className="rounded-2xl border p-5" style={{ borderColor: b.color + "55", background: b.soft }}>
          <div className="flex items-center gap-3"><ProviderMark provider={id} size={26} /><h2 className="text-base font-semibold" style={{ color: b.color }}>{b.name}</h2></div>
          <p className={`mt-3 text-sm font-medium ${tone}`}>{state}</p>
          {q?.error && <p className="mt-1 text-[11px] text-muted">{q.error}</p>}
          <div className="mt-4 space-y-3">
            {q?.windows.map((w) => <div key={w.label}>
              <div className="mb-1 flex justify-between text-[11px]"><span className="text-slate-300">{w.label}</span><span className="font-medium">{Math.round(w.remaining_pct)}% livre</span></div>
              <div className="h-2 overflow-hidden rounded-full bg-black/40"><div className="h-full rounded-full" style={{ width: `${Math.max(2, Math.min(100, w.remaining_pct))}%`, background: barColor(w.remaining_pct) }} /></div>
              {w.resets && <p className="mt-1 text-[10px] text-muted">Renova em {when(w.resets)}</p>}
            </div>)}
          </div>
        </div>;
      })}
    </div>
  </div>;
}
