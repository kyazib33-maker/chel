import { useEffect, useState, type ReactNode } from "react";
import { MessageSquarePlus, PanelRightClose, PanelRightOpen, Pin, Puzzle, ShieldCheck, Smartphone } from "lucide-react";
import { useContextMenu } from "./lib/contextMenu";
import ChatView from "./features/chat/ChatView";
import ActivityPanel from "./features/chat/ActivityPanel";
import { finished } from "./features/chat/engine";
import { useChats } from "./features/chat/useChats";
import SkillsPanel from "./features/skills/SkillsPanel";
import RemotePanel from "./features/remote/RemotePanel";
import ApprovalsPanel from "./features/approvals/ApprovalsPanel";
import { brand } from "./lib/providers";
import { desktopBridgeAvailable, listTasks, onTaskEvent, type TaskEvent, type TaskSnapshot } from "./lib/tauri";

type Page = "chat" | "skills" | "approvals" | "remote";

function ago(t: number) {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "agora" : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
}

export default function App() {
  const [page, setPage] = useState<Page>("chat");
  const [tasks, setTasks] = useState<TaskSnapshot[]>([]);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [showActivity, setShowActivity] = useState(true);
  const hub = useChats(tasks, events);
  const menu = useContextMenu();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  async function refresh() {
    if (!desktopBridgeAvailable) return;
    try { setTasks(await listTasks()); } catch { /* ignore */ }
  }

  useEffect(() => {
    void refresh();
    if (!desktopBridgeAvailable) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void onTaskEvent((event) => {
      setEvents((current) => [...current.slice(-7999), event]);
      if (event.payload.type === "state_changed") void refresh();
      setTasks((current) => current.map((task) => {
        if (task.task_id !== event.task_id) return task;
        switch (event.payload.type) {
          case "state_changed": return { ...task, status: event.payload.data.status };
          case "error": return { ...task, last_error: event.payload.data.message };
          default: return task;
        }
      }));
    }).then((stop) => { if (disposed) stop(); else unlisten = stop; });
    const reconciliation = window.setInterval(() => { void refresh(); }, 5000);
    return () => { disposed = true; window.clearInterval(reconciliation); unlisten?.(); };
  }, []);

  const runningIn = (chatId: string) => {
    const chat = hub.chats.find((c) => c.id === chatId);
    const last = chat?.turns[chat.turns.length - 1]?.attempts.at(-1);
    const task = last && tasks.find((t) => t.task_id === last.taskId);
    return task && !finished.includes(task.status) ? last.provider : null;
  };

  const navLink = (id: Page, label: string, icon: ReactNode) => <button onClick={() => setPage(id)} className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition ${page === id ? "bg-raised text-white" : "text-zinc-400 hover:bg-raised/60 hover:text-zinc-200"}`}>{icon}{label}</button>;

  return (
    <main className="flex h-screen overflow-hidden bg-canvas text-zinc-100">
      <aside className="flex w-[260px] shrink-0 flex-col border-r border-line/70 bg-sidebar">
        <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-violet-400 to-fuchsia-500 text-[15px] font-bold text-white shadow-lg shadow-violet-500/20">C</div>
          <div><p className="text-[14px] font-semibold tracking-tight">Chel</p><p className="text-[11px] text-muted">Suas IAs num lugar só</p></div>
        </div>
        <div className="px-3">
          <button onClick={() => { hub.createChat(); setPage("chat"); }} className="flex w-full items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-[13px] text-zinc-200 transition hover:border-zinc-600 hover:bg-raised"><MessageSquarePlus size={15} />Nova conversa</button>
        </div>

        <p className="px-5 pb-1.5 pt-5 text-[11px] font-semibold uppercase tracking-wider text-muted">Conversas</p>
        <div className="flex-1 space-y-0.5 overflow-y-auto px-2">
          {[...hub.chats].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt).map((c, i, all) => {
            const on = page === "chat" && c.id === hub.activeId;
            const live = runningIn(c.id);
            const firstUnpinned = !c.pinned && i > 0 && all[i - 1].pinned;
            return <div key={c.id}>
              {firstUnpinned && <div className="mx-2.5 my-1.5 h-px bg-line/70" />}
              <div onClick={() => { hub.setActiveId(c.id); setPage("chat"); }}
                onContextMenu={(e) => menu.open(e, [
                  { label: "Renomear", action: () => { setRenaming(c.id); setDraft(c.title); } },
                  { label: c.pinned ? "Desafixar" : "Fixar no topo", action: () => hub.togglePin(c.id) },
                  { label: "Apagar", danger: true, action: () => { if (confirm(`Apagar a conversa "${c.title}"?`)) hub.removeChat(c.id); } },
                ])}
                className={`group flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 transition ${on ? "bg-raised" : "hover:bg-raised/60"}`}>
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${live ? "animate-pulse" : ""}`} style={{ background: live ? brand[live].color : "transparent" }} />
                {renaming === c.id
                  ? <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onClick={(e) => e.stopPropagation()} onBlur={() => { hub.renameChat(c.id, draft); setRenaming(null); }} onKeyDown={(e) => { if (e.key === "Enter") { hub.renameChat(c.id, draft); setRenaming(null); } if (e.key === "Escape") setRenaming(null); }} className="min-w-0 flex-1 rounded bg-canvas px-1.5 py-0.5 text-[13px] text-white outline-none ring-1 ring-zinc-600" />
                  : <span className={`min-w-0 flex-1 truncate text-[13px] ${on ? "text-white" : "text-zinc-400 group-hover:text-zinc-200"}`}>{c.title}</span>}
                {c.pinned ? <Pin size={11} className="shrink-0 text-muted" /> : <span className="text-[10px] text-muted">{ago(c.updatedAt)}</span>}
              </div>
            </div>;
          })}
        </div>

        <div className="space-y-0.5 border-t border-line/70 p-2">
          {navLink("skills", "Skills", <Puzzle size={15} />)}
          {navLink("approvals", "Permissões", <ShieldCheck size={15} />)}
          {navLink("remote", "Usar no celular", <Smartphone size={15} />)}
          <p className="flex items-center gap-2 px-2.5 pt-2 text-[11px] text-muted"><span className={`h-1.5 w-1.5 rounded-full ${desktopBridgeAvailable ? "bg-emerald-400" : "bg-amber-400"}`} />{desktopBridgeAvailable ? "Pronto" : "Abra pelo app instalado"}</p>
        </div>
      </aside>

      {page === "chat" ? <>
        <div className="relative flex min-w-0 flex-1">
          <ChatView hub={hub} tasks={tasks} />
          <button onClick={() => setShowActivity((v) => !v)} className="absolute right-3 top-2.5 rounded-md p-1.5 text-muted transition hover:bg-raised hover:text-zinc-200" title={showActivity ? "Esconder atividade" : "Mostrar atividade"}>{showActivity ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}</button>
        </div>
        {showActivity && <ActivityPanel hub={hub} tasks={tasks} />}
      </> : <div className="min-w-0 flex-1 overflow-y-auto p-8">
        {page === "skills" && <SkillsPanel />}
        {page === "approvals" && <div className="mx-auto max-w-5xl"><h1 className="mb-1 text-lg font-semibold">Permissões</h1><p className="mb-6 text-sm text-muted">Quando uma IA quer fazer algo sensível, ela pede seu OK aqui.</p><ApprovalsPanel /></div>}
        {page === "remote" && <div className="mx-auto max-w-5xl"><h1 className="mb-1 text-lg font-semibold">Usar no celular</h1><p className="mb-6 text-sm text-muted">Conecte o app do celular lendo o QR Code.</p><RemotePanel /></div>}
      </div>}
    </main>
  );
}
