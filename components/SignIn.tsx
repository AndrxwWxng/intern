"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useState } from "react";

/**
 * The gate. Email + password, because that's the provider wired in
 * `convex/auth.ts` — swapping in Google or a magic link changes this file and
 * nothing else.
 *
 * Same terminal surface as the cockpit behind it: a sign-in screen that looks
 * like a different product is a seam the demo doesn't need.
 */
export default function SignIn() {
  const { signIn } = useAuthActions();
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setBusy(true);

    const form = new FormData(event.currentTarget);
    form.set("flow", mode);

    try {
      await signIn("password", form);
    } catch (err) {
      // Convex auth deliberately doesn't say which half was wrong, so we
      // don't invent a distinction the server refused to make. The one case
      // it *is* explicit about is a taken email, which surfaces as an
      // "already exists" throw from createAccountFromCredentials.
      const raw = err instanceof Error ? err.message : String(err);
      setError(
        /already exists/i.test(raw)
          ? "That email already has an account — switch to sign in."
          : /InvalidAccountId|InvalidSecret/i.test(raw)
            ? mode === "signIn"
              ? "No account with that email and password."
              : "That email is already taken, or the password is too short (8+)."
            : raw.replace(/^\[.*?\]\s*/, "").slice(0, 200),
      );
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-bg px-4">
      <div className="w-full max-w-[340px]">
        <div className="mb-6 flex items-baseline gap-3">
          <span className="tracking-[0.28em] text-fg">INTERN</span>
          <span className="text-line-2">|</span>
          <span className="text-faint">company brain</span>
        </div>

        <form onSubmit={submit} className="border border-line bg-panel">
          <div className="flex border-b border-line">
            {(["signIn", "signUp"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setMode(m);
                  setError(null);
                }}
                className={`flex-1 px-3 py-2 transition-colors ${
                  mode === m
                    ? "bg-raised text-fg"
                    : "text-faint hover:bg-raised/50 hover:text-dim"
                }`}
              >
                {m === "signIn" ? "sign in" : "create account"}
              </button>
            ))}
          </div>

          <div className="space-y-2 p-3">
            <label className="block">
              <span className="label">email</span>
              <input
                name="email"
                type="email"
                required
                autoComplete="email"
                spellCheck={false}
                className="mt-1 w-full border border-line bg-bg px-2 py-1.5 text-fg placeholder:text-faint/60 focus:border-line-2"
                placeholder="you@company.com"
              />
            </label>

            <label className="block">
              <span className="label">password</span>
              <input
                name="password"
                type="password"
                required
                minLength={8}
                autoComplete={
                  mode === "signIn" ? "current-password" : "new-password"
                }
                className="mt-1 w-full border border-line bg-bg px-2 py-1.5 text-fg placeholder:text-faint/60 focus:border-line-2"
                placeholder={mode === "signUp" ? "8 characters minimum" : "••••••••"}
              />
            </label>

            {error ? (
              <p className="border-l border-err/50 pl-2 text-err">{error}</p>
            ) : null}

            <button
              type="submit"
              disabled={busy}
              className="w-full border border-ok/40 py-1.5 text-ok transition-colors hover:bg-ok/10 disabled:opacity-50"
            >
              {busy
                ? "…"
                : mode === "signIn"
                  ? "sign in ⏎"
                  : "create account ⏎"}
            </button>
          </div>
        </form>

        <p className="mt-3 text-faint leading-relaxed">
          Everyone signs in against the same brain. What an intern drafts, you
          approve — and it goes out as you.
        </p>
      </div>
    </div>
  );
}
