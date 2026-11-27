import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Check, Copy, Power, RefreshCw, Smartphone, X } from "lucide-react";
import {
  createRemotePairing, desktopBridgeAvailable, getRemoteServerInfo, listPairedDevices, revokePairedDevice, startRemoteServer, stopRemoteServer,
  type PairingInfo, type PairedDevice, type RemoteServerInfo,
} from "../../lib/tauri";

type Pairing = PairingInfo & { short_codes?: Array<{ label: string; endpoint: string; code: string }> };

export default function RemotePanel() {
  const [server, setServer] = useState<RemoteServerInfo | null>(null);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [, tick] = useState(0);

  const refresh = useCallback(async () => {
    if (!desktopBridgeAvailable) return;
    try {
      const status = await getRemoteServerInfo();
      setServer(status);
      setDevices(status.running ? await listPairedDevices() : []);
    } catch (reason) { setError(String(reason)); }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); tick((n) => n + 1); }, 5000);
    const clock = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => { window.clearInterval(timer); window.clearInterval(clock); };
  }, [refresh]);

  async function run(action: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await action(); } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  }
  const turnOn = () => run(async () => {
    if (server?.running && !server.lan_enabled) await stopRemoteServer();
    setServer(await startRemoteServer(true));
    setPairing(await createRemotePairing() as Pairing);
    await refresh();
  });
  const turnOff = () => run(async () => { await stopRemoteServer(); setPairing(null); await refresh(); });
  const newCode = () => run(async () => { setPairing(await createRemotePairing() as Pairing); });
  const revoke = (id: string) => { if (window.confirm("Desconectar este aparelho? Ele vai precisar de um código novo para voltar.")) void run(async () => { await revokePairedDevice(id); await refresh(); }); };
  async function copy(code: string) {
    try { await navigator.clipboard.writeText(code); setCopied(code); window.setTimeout(() => setCopied(null), 1500); } catch { setError("Não foi possível copiar."); }
  }

  const on = !!server?.running && server.lan_enabled;
  const secondsLeft = pairing ? Math.max(0, Math.round((new Date(pairing.expires_at).getTime() - Date.now()) / 1000)) : 0;
  const expired = !!pairing && secondsLeft === 0;

  return <div className="space-y-5">
    {!desktopBridgeAvailable && <p className="text-sm text-amber-300">Abra pelo app instalado para conectar o celular.</p>}
    {error && <p className="break-words rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{error}</p>}

    <section className="rounded-2xl border border-line bg-panel p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${on ? "bg-emerald-400/15 text-emerald-300" : "bg-raised text-muted"}`}><Smartphone size={19} /></div>
          <div><p className="text-sm font-semibold">{on ? "Acesso pelo celular ligado" : "Acesso pelo celular desligado"}</p><p className="text-xs text-muted">{on ? "Celulares conectados conseguem usar suas conversas." : "Ligue para gerar um código de conexão."}</p></div>
        </div>
        {on ? <button disabled={busy} onClick={() => void turnOff()} className="flex items-center gap-2 rounded-lg border border-line px-3.5 py-2 text-xs text-zinc-300 transition hover:bg-raised disabled:opacity-50"><Power size={13} />Desligar</button>
          : <button disabled={busy || !desktopBridgeAvailable} onClick={() => void turnOn()} className="flex items-center gap-2 rounded-lg bg-zinc-100 px-4 py-2 text-xs font-semibold text-zinc-900 transition hover:bg-white disabled:opacity-50"><Power size={13} />{busy ? "Ligando…" : "Ligar e gerar código"}</button>}
      </div>

      {on && <div className="mt-6 border-t border-line pt-6">
        {!pairing || expired ? <div className="text-center">
          <p className="text-sm text-muted">{expired ? "O código expirou." : "Gere um código para conectar um celular."}</p>
          <button disabled={busy} onClick={() => void newCode()} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-zinc-100 px-4 py-2 text-xs font-semibold text-zinc-900 hover:bg-white disabled:opacity-50"><RefreshCw size={13} />Gerar código</button>
        </div> : <div className="grid items-center gap-8 md:grid-cols-[1fr_auto]">
          <div>
            <p className="text-xs text-muted">No app Chel do celular, toque em <b className="text-zinc-300">Conectar</b> e digite:</p>
            <div className="mt-4 space-y-3">
              {(pairing.short_codes ?? []).map((c) => <div key={c.code}>
                <p className="mb-1.5 text-[11px] text-muted">{c.label}</p>
                <button onClick={() => void copy(c.code)} className="group flex items-center gap-3 rounded-xl border border-line bg-canvas px-4 py-3 transition hover:border-zinc-600" title="Copiar">
                  <span className="font-mono text-xl font-semibold tracking-wider text-white">{c.code}</span>
                  {copied === c.code ? <Check size={15} className="text-emerald-400" /> : <Copy size={15} className="text-muted group-hover:text-zinc-300" />}
                </button>
              </div>)}
              {(pairing.short_codes ?? []).length === 0 && <p className="text-sm text-amber-300">Não encontrei um endereço de rede deste PC. Confira se está conectado ao Wi-Fi.</p>}
            </div>
            <p className="mt-4 text-[11px] text-muted">Vale por mais {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, "0")} · só serve uma vez · 5 erros invalidam o código.</p>
          </div>
          <div className="text-center"><div className="rounded-2xl bg-white p-2.5"><QRCodeSVG value={pairing.qr_payload} size={150} level="M" /></div><p className="mt-2 text-[11px] text-muted">ou leia o QR</p></div>
        </div>}
        <p className="mt-6 rounded-xl bg-raised/60 px-4 py-3 text-[11px] leading-relaxed text-muted">Funciona com o celular na <b className="text-zinc-300">mesma rede Wi-Fi</b>. Para usar fora de casa, instale o <b className="text-zinc-300">Tailscale</b> no PC e no celular: aparece um segundo código que funciona de qualquer lugar. Não abra portas no roteador.</p>
      </div>}
    </section>

    {on && <section className="rounded-2xl border border-line bg-panel p-6">
      <h2 className="mb-3 text-sm font-semibold">Aparelhos conectados</h2>
      {devices.length === 0 ? <p className="text-xs text-muted">Nenhum ainda.</p> : <div className="divide-y divide-line">
        {devices.map((d) => <div key={d.id} className="flex items-center justify-between py-2.5">
          <div><p className="text-sm">{d.name}</p><p className="text-[11px] text-muted">{d.last_seen_at ? `Visto ${new Date(d.last_seen_at).toLocaleString("pt-BR")}` : `Conectado ${new Date(d.created_at).toLocaleString("pt-BR")}`}</p></div>
          <button onClick={() => revoke(d.id)} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted hover:bg-raised hover:text-rose-300"><X size={12} />Desconectar</button>
        </div>)}
      </div>}
    </section>}
  </div>;
}
