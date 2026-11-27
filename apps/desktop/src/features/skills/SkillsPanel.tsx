import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Download } from "lucide-react";
import { desktopBridgeAvailable } from "../../lib/tauri";

type Skill = { name: string; description: string; sources: string[]; in_library: boolean };
type Report = { imported: number; shared: number; library_path: string; skills: Skill[] };

const tone: Record<string, string> = { Claude: "#D97757", Codex: "#F4F4F5", Antigravity: "#4285F4", Compartilhada: "#a1a1aa", Chel: "#a78bfa" };

export default function SkillsPanel() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (desktopBridgeAvailable) void invoke<Skill[]>("list_skills").then(setSkills).catch((e) => setError(String(e))); }, []);

  async function importAll() {
    setBusy(true); setError(null); setMessage(null);
    try {
      const r = await invoke<Report>("import_skills");
      setSkills(r.skills);
      setMessage(`${r.imported} skill(s) novas no Chel e ${r.shared} cópia(s) entregues às IAs. Biblioteca: ${r.library_path}`);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }

  const missing = skills.filter((s) => !s.in_library).length;

  return <div className="mx-auto max-w-4xl">
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-lg font-semibold">Skills</h1><p className="text-sm text-muted">Habilidades extras de todas as suas IAs, reunidas no Chel e compartilhadas entre elas.</p></div>
      <button disabled={!desktopBridgeAvailable || busy} onClick={() => void importAll()} className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-zinc-950 disabled:opacity-40"><Download size={15} />{busy ? "Importando…" : missing > 0 ? `Importar ${missing} skill(s)` : "Importar de novo"}</button>
    </div>
    {!desktopBridgeAvailable && <p className="mb-4 text-sm text-amber-300">Abra pelo app instalado para ver as skills.</p>}
    {message && <p className="mb-4 break-words text-sm text-emerald-300">{message}</p>}
    {error && <p className="mb-4 break-words text-sm text-rose-300">{error}</p>}
    <div className="divide-y divide-line rounded-xl border border-line bg-panel">
      {skills.length === 0 && desktopBridgeAvailable && <p className="p-5 text-sm text-muted">Nenhuma skill encontrada no computador.</p>}
      {skills.map((s) => <div key={s.name} className="flex items-start justify-between gap-4 p-4">
        <div className="min-w-0"><p className="text-sm font-medium">{s.name}</p>{s.description && <p className="mt-1 line-clamp-2 text-xs text-muted">{s.description}</p>}</div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
          {s.sources.map((src) => <span key={src} className="rounded-full border px-2 py-0.5 text-[10px]" style={{ borderColor: (tone[src] ?? "#71717a") + "88", color: tone[src] ?? "#a1a1aa" }}>{src}</span>)}
          {!s.in_library && <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[10px] text-amber-300">não importada</span>}
        </div>
      </div>)}
    </div>
  </div>;
}
