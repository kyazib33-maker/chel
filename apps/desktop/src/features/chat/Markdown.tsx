import type { ReactNode } from "react";

/** Inline: `code`, **bold**, *italic*, [link](url) shown as text. */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0; let m: RegExpExecArray | null; let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0]; const k = `${key}-${i++}`;
    if (t.startsWith("`")) out.push(<code key={k} className="rounded bg-raised px-1.5 py-0.5 font-mono text-[12.5px] text-violet-200">{t.slice(1, -1)}</code>);
    else if (t.startsWith("**")) out.push(<strong key={k} className="font-semibold text-white">{t.slice(2, -2)}</strong>);
    else if (t.startsWith("[")) out.push(<span key={k} className="text-violet-300 underline decoration-violet-300/40">{t.slice(1, t.indexOf("]"))}</span>);
    else out.push(<em key={k}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Small, safe Markdown renderer for AI answers (no HTML injection). */
export default function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let i = 0; let n = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const body: string[] = []; i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++;
      blocks.push(<pre key={n++} className="overflow-x-auto rounded-xl border border-line bg-[#0a0a0d] p-3.5 font-mono text-[12.5px] leading-relaxed text-zinc-300">{body.join("\n")}</pre>);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { blocks.push(<p key={n++} className={`font-semibold text-white ${h[1].length <= 2 ? "text-[16px]" : "text-[14.5px]"}`}>{inline(h[2], `h${n}`)}</p>); i++; continue; }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line); const items: string[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, ""));
      const cls = `space-y-1 pl-5 ${ordered ? "list-decimal" : "list-disc"} marker:text-zinc-500`;
      const lis = items.map((it, k) => <li key={k}>{inline(it, `l${n}-${k}`)}</li>);
      blocks.push(ordered ? <ol key={n++} className={cls}>{lis}</ol> : <ul key={n++} className={cls}>{lis}</ul>);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !lines[i].startsWith("```") && !/^(#{1,4})\s/.test(lines[i]) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={n++}>{inline(para.join("\n"), `p${n}`)}</p>);
  }
  return <div className="space-y-3 whitespace-pre-wrap text-[14px] leading-7 text-zinc-200">{blocks}</div>;
}
