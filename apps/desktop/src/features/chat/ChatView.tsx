import { useEffect, useRef, useState } from "react";
import { ArrowUp, FolderOpen, Square, Wand2 } from "lucide-react";
import { brand, effortName, ProviderMark } from "../../lib/providers";
import { cancelTask, desktopBridgeAvailable, type ProviderId, type TaskSnapshot } from "../../lib/tauri";
import { finished, prettyModel, qualityLabel, type Chat, type Quality } from "./engine";
import type { useChats } from "./useChats";
import Markdown from "./Markdown";

type Hub = ReturnType<typeof useChats>;
const picks: Array<ProviderId | "auto"> = ["auto", "claude_code", "codex", "antigravity"];

export default function ChatView({ hub, tasks }: { hub: Hub; tasks: TaskSnapshot[] }) {
  const chat = hub.active as Chat;
  const [text, setText] = useState("");
  const [forced, setForced] = useState<ProviderId | "auto">("auto");
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [chat?.id, chat?.turns.length, chat?.turns[chat.turns.length - 1]?.answer]);
  useEffect(() => { input.current?.focus(); setText(""); setForced("auto"); }, [chat?.id]);
  useEffect(() => { const el = input.current; if (el) { el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, 200)}px`; } }, [text]);

  if (!chat) return null;
  const workDir = chat.folder.trim() || hub.fallbackDir;
  const ready = desktopBridgeAvailable && !!workDir;
  const busy = !!hub.busy[chat.id];

  function submit() {
    if (!ready || busy || !text.trim()) return;
    void hub.send(chat.id, text.trim(), forced);
    setText("");
  }

  return <div className="flex h-screen min-w-0 flex-1 flex-col">
    <header className="flex items-center gap-3 border-b border-line/70 py-3 pl-6 pr-14">
      <h1 className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-200">{chat.title}</h1>
      <label className="group flex w-72 items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-muted transition hover:bg-raised focus-within:bg-raised" title="Pasta onde a IA trabalha">
        <FolderOpen size={13} className="shrink-0" />
        <input value={chat.folder} onChange={(e) => hub.setFolder(chat.id, e.target.value)} placeholder={hub.fallbackDir ? "Documentos\\Psylium (padrão)" : "Pasta (opcional)"} className="min-w-0 flex-1 bg-transparent text-zinc-300 outline-none placeholder:text-muted" />
      </label>
      <div className="flex rounded-lg bg-raised p-0.5 text-xs" title="Econômico gasta menos; Caprichado usa modelos melhores">
        {(Object.keys(qualityLabel) as Quality[]).map((q) => <button key={q} onClick={() => hub.setQuality(chat.id, q)} className={`rounded-md px-2.5 py-1 transition ${chat.quality === q ? "bg-zinc-700/80 text-white shadow-sm" : "text-muted hover:text-zinc-200"}`}>{qualityLabel[q]}</button>)}
      </div>
    </header>

    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-8 px-6 py-8">
        {chat.turns.length === 0 && <div className="pt-[18vh] text-center">
          <div className="mx-auto flex w-fit items-center gap-3 opacity-90">{(["claude_code", "codex", "antigravity"] as ProviderId[]).map((p) => <ProviderMark key={p} provider={p} size={22} />)}</div>
          <h2 className="mt-5 text-2xl font-semibold tracking-tight">Como posso ajudar?</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted">Escreva normalmente. O Psylium escolhe a IA e o modelo que entregam bem gastando pouco — ou diga “usa o Codex” para escolher você.</p>
        </div>}

        {chat.turns.map((turn) => {
          const last = turn.attempts[turn.attempts.length - 1];
          const taskId = last && last.taskId !== "pending" ? last.taskId : null;
          const task = tasks.find((t) => t.task_id === taskId);
          const live = taskId ? (hub.streams.replies.get(taskId) ?? []).join("\n\n") : "";
          const reply = live || turn.answer || "";
          const stale = !task && !reply && !turn.error && Date.now() - turn.at > 120_000;
          const running = !turn.error && !stale && !!taskId && (task ? !finished.includes(task.status) : !turn.answer);
          const provider = last?.provider ?? turn.route?.provider;
          const b = provider ? brand[provider] : null;
          const model = last?.modelName ?? (turn.route?.model ? prettyModel(turn.route.model) : null);
          const effort = turn.route ? effortName[turn.route.effort] ?? turn.route.effort : null;
          return <div key={turn.id} className="space-y-4">
            <div className="flex justify-end"><div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-raised px-4 py-2.5 text-[14px] leading-relaxed text-zinc-100">{turn.prompt}</div></div>
            <div className="flex gap-3">
              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-1" style={{ background: b?.soft ?? "#1b1b21", ["--tw-ring-color" as string]: (b?.color ?? "#3f3f46") + "55" }}>{provider ? <ProviderMark provider={provider} size={15} /> : <Wand2 size={13} className="text-muted" />}</div>
              <div className="min-w-0 flex-1">
                <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]" title={turn.route?.rationale.join("\n")}>
                  {b ? <span className="font-semibold" style={{ color: b.color }}>{b.name}</span> : <span className="text-muted">Escolhendo a IA…</span>}
                  {model && <span className="rounded-md bg-raised px-1.5 py-0.5 text-zinc-300">{model}</span>}
                  {effort && <span className="rounded-md bg-raised px-1.5 py-0.5 text-zinc-400">esforço {effort}</span>}
                  {running && <span className="flex items-center gap-1.5 text-muted"><span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: b?.color }} />trabalhando</span>}
                </div>
                {turn.notes.map((n, i) => <p key={i} className="mb-1.5 text-[12px] text-amber-300/90">{n}</p>)}
                {turn.error ? <p className="text-[14px] text-rose-300">Não deu certo: {turn.error}</p>
                  : reply ? <Markdown text={reply} />
                  : (task && finished.includes(task.status)) || stale ? <p className="text-[14px] text-muted">A IA terminou sem enviar resposta em texto.</p>
                  : <div className="flex gap-1 py-2">{[0, 1, 2].map((i) => <span key={i} className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-500" style={{ animationDelay: `${i * 120}ms` }} />)}</div>}
                {task?.status === "awaiting_approval" && <p className="mt-2 text-[12px] text-violet-300">A IA está pedindo permissão — abra “Permissões”.</p>}
                {running && taskId && <button onClick={() => void cancelTask(taskId)} className="mt-2 flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] text-muted transition hover:bg-raised hover:text-zinc-200"><Square size={9} fill="currentColor" />Parar</button>}
              </div>
            </div>
          </div>;
        })}
        <div ref={bottom} />
      </div>
    </div>

    <div className="px-6 pb-5">
      <div className="mx-auto max-w-3xl rounded-2xl border border-line bg-panel shadow-[0_8px_30px_rgba(0,0,0,0.35)] transition focus-within:border-zinc-600">
        <textarea ref={input} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }} rows={1}
          placeholder={ready ? "Mensagem para o Psylium…" : desktopBridgeAvailable ? "Preparando…" : "Abra pelo app instalado para conversar"}
          className="block max-h-[200px] w-full resize-none bg-transparent px-4 pb-2 pt-3.5 text-[14px] leading-relaxed outline-none placeholder:text-muted" />
        <div className="flex items-center justify-between px-2.5 pb-2.5">
          <div className="flex items-center gap-0.5 rounded-lg bg-raised p-0.5" title="Qual IA responde">
            {picks.map((p) => {
              const on = forced === p;
              return <button key={p} onClick={() => setForced(p)} className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition ${on ? "bg-zinc-700/80 text-white" : "text-muted hover:text-zinc-200"}`}>
                {p === "auto" ? <Wand2 size={11} /> : <ProviderMark provider={p} size={11} />}{p === "auto" ? "Automático" : brand[p].name}
              </button>;
            })}
          </div>
          <button disabled={!ready || busy || !text.trim()} onClick={submit} className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-100 text-zinc-900 transition hover:bg-white disabled:bg-zinc-700 disabled:text-zinc-500" title="Enviar (Enter)"><ArrowUp size={16} /></button>
        </div>
      </div>
      <p className="mx-auto mt-2 max-w-3xl text-center text-[11px] text-muted/80">Trabalhando em {workDir || "…"}</p>
    </div>
  </div>;
}
