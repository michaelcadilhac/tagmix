"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useAccount } from "@/components/account-provider";
import { errorMessage } from "@/lib/account-client";

export function AccountForm() {
  const { user, loading, signIn, signOut } = useAccount();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await signIn(mode, String(data.get("email")), String(data.get("password")));
      const next = new URLSearchParams(window.location.search).get("next");
      router.push(next && /^\/(?!\/)[a-zA-Z0-9/_-]*$/.test(next) ? next : "/folders");
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  async function logout() {
    setBusy(true);
    setError("");
    try { await signOut(); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  if (loading) return <p role="status">Loading your account…</p>;
  return <div className="account-card">
    {user ? <>
      <h1>Your account</h1><p className="account-email">Signed in as {user.email}</p>
      <button className="button button-secondary" disabled={busy} onClick={() => void logout()} type="button">Sign out</button>
    </> : <>
      <h1>{mode === "login" ? "Sign in" : "Create an account"}</h1>
      {mode === "signup" && <p>Save folders and rehearsal marks across devices.</p>}
      <form className="account-form" onSubmit={submit}>
        <label>Email address<input autoComplete="email" name="email" type="email" maxLength={254} required /></label>
        <label>Password<input autoComplete={mode === "login" ? "current-password" : "new-password"} name="password" type="password" minLength={12} maxLength={128} required aria-describedby={mode === "signup" ? "password-help" : undefined} /></label>
        {mode === "signup" && <p id="password-help" className="form-hint">Use 12–128 characters.</p>}
        <button className="button button-primary" disabled={busy} type="submit">{busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}</button>
      </form>
      <button className="text-link" disabled={busy} onClick={() => { setMode(mode === "login" ? "signup" : "login"); setError(""); }} type="button">
        {mode === "login" ? "New here? Create an account" : "Already have an account? Sign in"}
      </button>
    </>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}
