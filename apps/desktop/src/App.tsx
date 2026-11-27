import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Activity, Command, LayoutDashboard, MessageCircle, Puzzle, ShieldCheck, Smartphone } from "lucide-react";
import ChatHome from "./features/chat/ChatHome";
import Dashboard from "./features/dashboard/Dashboard";
import SkillsPanel from "./features/skills/SkillsPanel";
import RemotePanel from "./features/remote/RemotePanel";
import ApprovalsPanel from "./features/approvals/ApprovalsPanel";
import { desktopBridgeAvailable, listTasks, onTaskEvent, type TaskEvent, type TaskSnapshot } from "./lib/tauri";

type Page = "chat" | "dashboard" | "skills" | "approvals" | "remote";
type NavItem = { id: Page; label: string; hint: string; icon: ReactNode };

const nav: NavItem[] = [
  { id: "chat", label: "Conversar", hint: "", icon: <MessageCircle size={16} /> },
  { id: "dashboard", label: "Painel", hint: "", icon: <LayoutDashboard size={16} /> },
  { id: "skills", label: "Skills", hint: "", icon: <Puzzle size={16} /> },
  { id: "approvals", label: "Pedidos de permissão", hint: "A IA quer fazer algo e precisa do seu OK", icon: <ShieldCheck size={16} /> },
  { id: "remote", label: "Usar no celular", hint: "Conecte o app do celular por QR Code", icon: <Smartphone size={16} /> },
];

export default function App() {
  const [page, setPage] = useState<Page>("chat");
  const [tasks, setTasks] = useState<TaskSnapshot[]>([]);
  const [events, setEvents] = useState<TaskEvent[]>([]);

  const activeCount = useMemo(() => tasks.filter((task) => ["queued", "starting", "running", "cancelling", "awaiting_approval"].includes(task.status)).length, [tasks]);

  async function refresh() {
    if (!desktopBridgeAvailable) return;
    try { setTasks(await listTasks()); } catch { /* shown per page */ }
  }

  useEffect(() => {
    void refresh();
    if (!desktopBridgeAvailable) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void onTaskEvent((event) => {
      setEvents((current) => [...current.slice(-4999), event]);
      if (event.payload.type === "state_changed") void refresh();
      setTasks((current) => current.map((task) => {
        if (task.task_id !== event.task_id) return task;
        switch (event.payload.type) {
          case "state_changed": return { ...task, status: event.payload.data.status };
          case "error": return { ...task, last_error: event.payload.data.message };
          case "exited": return { ...task, exit_code: event.payload.data.code };
          default: return task;
        }
      }));
    }).then((stop) => { if (disposed) stop(); else unlisten = stop; });
    const reconciliation = window.setInterval(() => { void refresh(); }, 5000);
    return () => { disposed = true; window.clearInterval(reconciliation); unlisten?.(); };
  }, []);

  const current = nav.find((item) => item.id === page)!;

  return (
    <main className="flex min-h-screen bg-canvas text-zinc-100">
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col gap-1 overflow-y-auto border-r border-line p-4">
        <div className="mb-5 flex items-center gap-3 px-2"><div className="rounded-xl border border-line bg-panel p-2 text-accent"><Command size={20} /></div><div><p className="text-sm font-semibold tracking-wide">Psylium</p><p className="text-[11px] text-muted">Suas IAs num lugar só</p></div></div>
        {nav.map((item) => <button key={item.id} onClick={() => setPage(item.id)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition ${page === item.id ? "bg-slate-700 text-white" : "text-slate-400 hover:bg-panel hover:text-white"}`}>{item.icon}<span>{item.label}</span></button>)}
        <div className="mt-auto space-y-2 px-3 pt-4 text-xs text-muted">
          <p className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${desktopBridgeAvailable ? "bg-emerald-400" : "bg-amber-400"}`} />{desktopBridgeAvailable ? "Pronto" : "Abra pelo app instalado"}</p>
          <p className="flex items-center gap-2"><Activity size={13} />{activeCount === 0 ? "Nenhuma IA trabalhando" : `${activeCount} IA(s) trabalhando`}</p>
        </div>
      </aside>

      <div className={`min-w-0 flex-1 ${page === "chat" ? "px-6 pt-6" : "p-6"}`}>
        {current.hint && <div className="mb-5"><h1 className="text-lg font-semibold">{current.label}</h1><p className="text-sm text-muted">{current.hint}</p></div>}
        {page === "chat" && <ChatHome tasks={tasks} events={events} />}
        {page === "dashboard" && <Dashboard />}
        {page === "skills" && <SkillsPanel />}
        {page === "approvals" && <ApprovalsPanel />}
        {page === "remote" && <RemotePanel />}
      </div>
    </main>
  );
}
