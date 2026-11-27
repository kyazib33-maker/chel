import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { AlertTriangle, Check, Copy, Laptop, RefreshCw, Shield, Smartphone, Wifi, WifiOff, X } from "lucide-react";
import {
  createRemotePairing,
  desktopBridgeAvailable,
  getRemoteServerInfo,
  getUsageSnapshot,
  listPairedDevices,
  revokePairedDevice,
  startRemoteServer,
  stopRemoteServer,
  type PairingInfo,
  type PairedDevice,
  type ProviderUsage,
  type RemoteServerInfo,
  type UsageSnapshot,
} from "../../lib/tauri";

const providerLabels = {
  claude_code: "Claude Code",
  codex: "Codex CLI",
  antigravity: "Antigravity",
} as const;

export default function RemotePanel() {
  const [server, setServer] = useState<RemoteServerInfo | null>(null);
  const [pairing, setPairing] = useState<PairingInfo | null>(null);
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [enableLan, setEnableLan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    if (!desktopBridgeAvailable) return;
    try {
      const [status, metrics] = await Promise.all([getRemoteServerInfo(), getUsageSnapshot()]);
      setServer(status);
      setUsage(metrics);
      if (status.running) setDevices(await listPairedDevices());
      else setDevices([]);
    } catch (reason) {
      setError(String(reason));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 20_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function start() {
    setBusy(true); setError(null); setPairing(null);
    try {
      setServer(await startRemoteServer(enableLan));
      await refresh();
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  async function stop() {
    setBusy(true); setError(null);
    try {
      await stopRemoteServer();
      setPairing(null);
      await refresh();
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  async function pair() {
    setBusy(true); setError(null);
    try { setPairing(await createRemotePairing()); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  async function revoke(id: string) {
    if (!window.confirm("Revogar o acesso deste dispositivo? Ele precisará parear novamente.")) return;
    try { await revokePairedDevice(id); await refresh(); }
    catch (reason) { setError(String(reason)); }
  }

  async function copyCode() {
    if (!pairing) return;
    try {
      await navigator.clipboard.writeText(pairing.pairing_code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { setError("Não foi possível copiar o código de pareamento."); }
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(360px,.9fr)]">
        <section className="rounded-2xl border border-line bg-panel p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-accent"><Smartphone size={17} /><h2 className="text-sm font-semibold text-zinc-100">Remote Control</h2></div>
              <p className="mt-1 text-xs text-muted">Conecte o aplicativo mobile ao Host deste computador.</p>
            </div>
            <span className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-[10px] ${server?.running ? "bg-emerald-400/10 text-emerald-300" : "bg-slate-700/60 text-slate-400"}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${server?.running ? "bg-emerald-400" : "bg-slate-500"}`} />
              {server?.running ? "Servidor ativo" : "Servidor desligado"}
            </span>
          </div>

          {!server?.running ? (
            <div className="mt-5 space-y-4">
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-canvas p-4">
                <input type="checkbox" checked={enableLan} onChange={(event) => setEnableLan(event.target.checked)} className="mt-0.5 accent-cyan-400" />
                <span>
                  <span className="flex items-center gap-2 text-xs font-medium text-zinc-100"><Wifi size={14} /> Habilitar acesso pela rede local</span>
                  <span className="mt-1 block text-[10px] leading-5 text-muted">Necessário para conectar o celular. Endereços Tailscale detectados também serão anunciados.</span>
                </span>
              </label>
              <button disabled={busy || !desktopBridgeAvailable} onClick={() => void start()} className="rounded-lg bg-accent px-4 py-2.5 text-xs font-semibold text-zinc-950 disabled:opacity-50">{busy ? "Iniciando..." : "Iniciar servidor remoto"}</button>
              {!desktopBridgeAvailable && <p className="text-[10px] text-amber-300">Abra o aplicativo pelo Tauri para iniciar o Host remoto.</p>}
            </div>
          ) : (
            <div className="mt-5 space-y-4">
              <div className="rounded-xl border border-line bg-canvas p-4">
                <p className="text-[10px] uppercase tracking-wider text-muted">Endereços anunciados</p>
                {server.endpoints.length ? server.endpoints.map((endpoint) => <p key={endpoint} className="mt-2 break-all font-mono text-xs text-cyan-200">{endpoint}</p>) : <p className="mt-2 text-xs text-amber-300">Nenhum endereço de rede foi detectado.</p>}
                <p className="mt-3 text-[10px] leading-5 text-muted">Porta {server.port} · {server.lan_enabled ? "LAN habilitada" : "Somente localhost"}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => void pair()} disabled={busy || !server.lan_enabled || server.endpoints.length === 0} className="rounded-lg bg-accent px-4 py-2.5 text-xs font-semibold text-zinc-950 disabled:opacity-40">{pairing ? "Gerar novo QR" : "Gerar QR de pareamento"}</button>
                <button onClick={() => void stop()} disabled={busy} className="rounded-lg border border-rose-400/30 px-4 py-2.5 text-xs text-rose-300 disabled:opacity-50">Desligar servidor</button>
              </div>
              {!server.lan_enabled && <p className="text-[10px] text-amber-300">O servidor está restrito a localhost. Desligue e inicie com acesso à rede para conectar o celular.</p>}
            </div>
          )}

          {server?.running && <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-[10px] leading-5 text-amber-200"><AlertTriangle size={14} className="mt-0.5 shrink-0" />{server.security_notice}</div>}
          {error && <p className="mt-3 break-all text-xs text-rose-300">{error}</p>}
        </section>

        <section className="rounded-2xl border border-line bg-panel p-5">
          <div className="flex items-center gap-2"><Shield size={16} className="text-accent" /><h2 className="text-sm font-semibold">Pareamento seguro</h2></div>
          {pairing ? (
            <div className="mt-4 flex flex-col items-center text-center">
              <div className="rounded-xl bg-white p-3"><QRCodeSVG value={pairing.qr_payload} size={220} level="M" includeMargin /></div>
              <p className="mt-3 text-xs font-medium">Escaneie com o aplicativo mobile</p>
              <p className="mt-1 text-[10px] text-muted">Código válido até {new Date(pairing.expires_at).toLocaleTimeString()}.</p>
              <div className="mt-3 flex items-center gap-2 rounded-lg border border-line bg-canvas px-3 py-2">
                <code className="max-w-[250px] break-all text-[10px] text-cyan-200">{pairing.pairing_code}</code>
                <button onClick={() => void copyCode()} title="Copiar código" className="text-muted hover:text-white">{copied ? <Check size={14} /> : <Copy size={14} />}</button>
              </div>
              <p className="mt-3 max-w-md text-[10px] leading-5 text-muted">O QR contém um código de uso único, não o token permanente do dispositivo. Após parear, o token é salvo no armazenamento seguro do celular.</p>
            </div>
          ) : (
            <div className="mt-4 flex min-h-[250px] flex-col items-center justify-center rounded-xl border border-dashed border-line bg-canvas/60 px-6 text-center">
              <Laptop size={27} className="text-slate-600" />
              <p className="mt-3 text-xs font-medium text-slate-300">Nenhum código ativo</p>
              <p className="mt-1 max-w-xs text-[10px] leading-5 text-muted">Inicie o servidor com LAN habilitada e gere um QR temporário para autorizar o celular.</p>
            </div>
          )}
        </section>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section className="rounded-2xl border border-line bg-panel p-5">
          <div className="flex items-center justify-between gap-3"><div><h2 className="text-sm font-semibold">Usage consolidado</h2><p className="mt-1 text-[10px] text-muted">Histórico local e observações ao vivo são exibidos separadamente.</p></div><button onClick={() => void refresh()} className="rounded-lg border border-line p-2 text-muted hover:text-white" title="Atualizar métricas"><RefreshCw size={14} /></button></div>
          <div className="mt-4 grid gap-3 lg:grid-cols-3">
            {usage?.providers.map((provider) => <UsageCard key={provider.provider} usage={provider} />)}
            {!usage && <p className="text-xs text-muted">Carregando métricas...</p>}
          </div>
          {usage && <p className="mt-3 text-[10px] text-muted">Atualizado em {new Date(usage.generated_at).toLocaleString()} · As cotas oficiais das assinaturas não são disponibilizadas por um endpoint universal dos CLIs.</p>}
        </section>

        <section className="rounded-2xl border border-line bg-panel p-5">
          <div className="flex items-center justify-between"><div><h2 className="text-sm font-semibold">Dispositivos autorizados</h2><p className="mt-1 text-[10px] text-muted">Tokens podem ser revogados individualmente.</p></div><Smartphone size={16} className="text-accent" /></div>
          <div className="mt-4 space-y-2">
            {devices.map((device) => <div key={device.id} className="flex items-center justify-between gap-2 rounded-lg border border-line bg-canvas p-3"><div className="min-w-0"><p className="truncate text-xs font-medium">{device.name}</p><p className="mt-1 text-[9px] text-muted">Visto: {device.last_seen_at ? new Date(device.last_seen_at).toLocaleString() : "Nunca"}</p></div><button onClick={() => void revoke(device.id)} className="shrink-0 rounded-md p-2 text-rose-300 hover:bg-rose-400/10" title="Revogar dispositivo"><X size={13} /></button></div>)}
            {!devices.length && <div className="rounded-lg border border-dashed border-line p-5 text-center"><WifiOff size={18} className="mx-auto text-slate-600" /><p className="mt-2 text-[10px] text-muted">Nenhum celular pareado.</p></div>}
          </div>
        </section>
      </div>
    </div>
  );
}

function UsageCard({ usage }: { usage: ProviderUsage }) {
  const quotaTone = usage.quota_status === "quota_exceeded" ? "text-rose-300" : usage.quota_status === "rate_limited" ? "text-amber-300" : usage.quota_status === "normal" ? "text-emerald-300" : "text-slate-400";
  return (
    <article className="rounded-xl border border-line bg-canvas p-4">
      <div className="flex items-start justify-between gap-3"><h3 className="text-xs font-semibold">{providerLabels[usage.provider]}</h3><span className={`text-[9px] uppercase tracking-wide ${quotaTone}`}>{usage.quota_status.replaceAll("_", " ")}</span></div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <Metric label="Tokens históricos" value={formatTokens(usage.historical.input_tokens + usage.historical.output_tokens + usage.historical.cache_read_tokens + usage.historical.cache_creation_tokens)} />
        <Metric label="Tokens ao vivo" value={usage.live_available ? formatTokens(usage.live.input_tokens + usage.live.output_tokens + usage.live.cache_read_tokens + usage.live.cache_creation_tokens) : "—"} />
        <Metric label="Registros lidos" value={usage.historical_available ? usage.sessions_scanned.toLocaleString() : "Não disponível"} />
        <Metric label="Tempo de execução" value={formatDuration(usage.execution_seconds)} />
      </div>
      <div className="mt-4 space-y-1 border-t border-line pt-3 text-[9px] leading-4 text-muted">{usage.notes.map((note) => <p key={note}>{note}</p>)}</div>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><p className="text-[9px] text-muted">{label}</p><p className="mt-1 text-sm font-semibold text-zinc-100">{value}</p></div>;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString();
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}
