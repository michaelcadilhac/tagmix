"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { accountRequest, errorMessage } from "@/lib/account-client";
import type { AccountUser } from "@/lib/account-types";
import { importLegacyMarks } from "@/lib/legacy-marks";

type AccountContextValue = {
  user: AccountUser | null; loading: boolean; error: string;
  refresh: () => Promise<void>;
  signIn: (action: "login" | "signup", email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
};
const AccountContext = createContext<AccountContextValue | null>(null);

async function importBrowserMarks(userId: string): Promise<void> {
  await importLegacyMarks(localStorage, (tagId, marks) => accountRequest(`marks/${tagId}`, { userId, method: "POST", body: { marks } }));
}

function notifyOtherTabs() {
  try { localStorage.setItem("tagmix:account-event", `${Date.now()}-${Math.random()}`); } catch { /* Storage can be disabled. */ }
}

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AccountUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [importError, setImportError] = useState("");
  const generation = useRef(0);
  const authChanging = useRef(false);

  const activate = useCallback(async (nextUser: AccountUser | null, version: number) => {
    let warning = "";
    if (nextUser) {
      try { await importBrowserMarks(nextUser.id); }
      catch { warning = "Some browser marks could not be imported. They remain on this device; retry to save them to your account."; }
    }
    if (version !== generation.current) return;
    setUser(nextUser);
    setImportError(warning);
    setError("");
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    if (authChanging.current) return;
    const version = ++generation.current;
    try {
      const data = await accountRequest<{ user: AccountUser | null }>("session");
      await activate(data.user, version);
    } catch (failure) {
      if (version !== generation.current) return;
      setError(errorMessage(failure));
      setLoading(false);
    }
  }, [activate]);

  useEffect(() => {
    void refresh();
    const onStorage = (event: StorageEvent) => { if (event.key === "tagmix:account-event") void refresh(); };
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    window.addEventListener("storage", onStorage);
    return () => {
      // This counter invalidates pending requests; it is not a DOM ref.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("storage", onStorage);
    };
  }, [refresh]);

  async function signIn(action: "login" | "signup", email: string, password: string) {
    authChanging.current = true;
    const version = ++generation.current;
    try {
      const data = await accountRequest<{ user: AccountUser }>(action, { method: "POST", body: { email, password } });
      await activate(data.user, version);
      notifyOtherTabs();
    } finally { authChanging.current = false; }
  }

  async function signOut() {
    authChanging.current = true;
    ++generation.current;
    try {
      await accountRequest("logout", { method: "POST", userId: user?.id });
      setUser(null);
      setImportError("");
      setError("");
      notifyOtherTabs();
    } finally { authChanging.current = false; }
  }

  return <AccountContext.Provider value={{ user, loading, error, refresh, signIn, signOut }}>
    {importError && <div className="account-banner" role="status">{importError} <button type="button" onClick={() => void refresh()}>Retry import</button></div>}
    {children}
  </AccountContext.Provider>;
}

export function useAccount(): AccountContextValue {
  const value = useContext(AccountContext);
  if (!value) throw new Error("AccountProvider is missing.");
  return value;
}

export function AccountNavigation() {
  const { user } = useAccount();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        container.current?.querySelector("button")?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const links = [["/", "Browse tags"], ["/tools", "Pitch tools"], ["/folders", "My folders"], ["/history", "Recently viewed"], ["/account", user ? "Account" : "Sign in"]];
  return <div className="primary-navigation" ref={container}>
    <button className="menu-toggle button button-secondary" aria-expanded={open} aria-controls="primary-menu" onClick={() => setOpen(!open)} type="button">{open ? "Close menu" : "Menu"}</button>
    <nav className={`header-nav ${open ? "is-open" : ""}`} id="primary-menu" aria-label="Primary navigation">
      {links.map(([href, label]) => <Link key={href} href={href} aria-current={(href === "/" ? pathname === href : pathname.startsWith(href)) ? "page" : undefined} onClick={() => setOpen(false)}>{label}</Link>)}
    </nav>
  </div>;
}

export function AccountRequired({ children }: { children: React.ReactNode }) {
  const { user, loading, error, refresh } = useAccount();
  if (loading) return <p role="status">Loading your account…</p>;
  if (error) return <div role="alert"><p>{error}</p><button className="button button-secondary" onClick={() => void refresh()}>Retry</button></div>;
  if (!user) return <p><Link className="text-link" href="/account">Sign in or create an account</Link> to continue.</p>;
  return children;
}
