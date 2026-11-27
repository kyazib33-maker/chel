import { createContext, useContext, useEffect, useState, type MouseEvent, type ReactNode } from "react";

export type MenuItem = { label: string; action: () => void; danger?: boolean };
type Ctx = { open: (e: MouseEvent, items: MenuItem[]) => void };
const MenuContext = createContext<Ctx>({ open: () => undefined });

/**
 * Replaces the browser's right-click menu (Voltar, Atualizar, Imprimir…).
 * Only places that offer their own items show a menu; text fields keep the
 * system menu so copy/paste still works there.
 */
export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  useEffect(() => {
    const block = (e: globalThis.MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea")) return;
      e.preventDefault();
    };
    const close = () => setMenu(null);
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("contextmenu", block);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", esc);
    window.addEventListener("resize", close);
    return () => { window.removeEventListener("contextmenu", block); window.removeEventListener("click", close); window.removeEventListener("blur", close); window.removeEventListener("keydown", esc); window.removeEventListener("resize", close); };
  }, []);

  const open = (e: MouseEvent, items: MenuItem[]) => {
    e.preventDefault(); e.stopPropagation();
    const width = 190; const height = items.length * 34 + 10;
    setMenu({ x: Math.min(e.clientX, window.innerWidth - width - 8), y: Math.min(e.clientY, window.innerHeight - height - 8), items });
  };

  return <MenuContext.Provider value={{ open }}>
    {children}
    {menu && <div className="fixed z-50 w-[190px] rounded-xl border border-line bg-panel p-1 shadow-2xl shadow-black/50" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
      {menu.items.map((item) => <button key={item.label} onClick={() => { setMenu(null); item.action(); }} className={`block w-full rounded-lg px-3 py-1.5 text-left text-[13px] transition hover:bg-raised ${item.danger ? "text-rose-300" : "text-zinc-200"}`}>{item.label}</button>)}
    </div>}
  </MenuContext.Provider>;
}

export const useContextMenu = () => useContext(MenuContext);
