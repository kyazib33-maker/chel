import { useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Download, X } from "lucide-react";
import { desktopBridgeAvailable } from "../../lib/tauri";

/**
 * Checks GitHub for a newer Chel when the app opens (and every 6 hours).
 * The update is only installed if its signature matches Chel's public key.
 */
export default function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (!desktopBridgeAvailable) return;
    const look = () => void check().then((u) => { if (u) setUpdate(u); }).catch(() => undefined);
    look();
    const timer = window.setInterval(look, 6 * 60 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  async function install() {
    if (!update) return;
    setError(null); setProgress(0);
    let total = 0; let done = 0;
    try {
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        if (e.event === "Progress") { done += e.data.chunkLength; if (total) setProgress(Math.round((done / total) * 100)); }
      });
      await relaunch();
    } catch (reason) { setError(String(reason)); setProgress(null); }
  }

  if (!update || hidden) return null;
  return <div className="fixed bottom-5 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3 shadow-2xl shadow-black/50">
    <Download size={16} className="text-violet-300" />
    <div className="text-[13px]">
      <p className="font-medium text-zinc-100">Nova versão do Chel: {update.version}</p>
      <p className="text-[11px] text-muted">{error ? `Não deu certo: ${error}` : progress !== null ? `Baixando… ${progress}%` : "Atualiza e reabre sozinho."}</p>
    </div>
    <button disabled={progress !== null} onClick={() => void install()} className="rounded-lg bg-zinc-100 px-3 py-1.5 text-[12px] font-semibold text-zinc-900 hover:bg-white disabled:opacity-50">Atualizar agora</button>
    {progress === null && <button onClick={() => setHidden(true)} className="rounded p-1 text-muted hover:text-zinc-200" title="Depois"><X size={14} /></button>}
  </div>;
}
