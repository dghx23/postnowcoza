import { useState } from "react";
import { useRouter } from "next/router";
import Link from "next/link";
import { signIn } from "next-auth/react";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    const result = await signIn("credentials", { email, password, redirect: false });

    setSubmitting(false);
    if (result?.error) {
      setError("Invalid email or password.");
      return;
    }
    router.push("/dashboard");
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={handleSubmit}>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 22, color: "var(--navy-900)" }}>
          Post<span style={{ color: "var(--teal-600)" }}>Now</span>{" "}
          <span className="e2-tag">E2</span>
        </div>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 20, color: "var(--navy-900)" }}>
          Sign in
        </div>
        <div className="field">
          <label htmlFor="email">Work email</label>
          <input
            id="email"
            type="email"
            placeholder="you@company.co.za"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        {error && <div className="form-error">{error}</div>}
        <button type="submit" className="btn btn-primary btn-full" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in to PostNow E2"}
        </button>
        <div style={{ fontSize: 12, color: "var(--text-muted)", textAlign: "center" }}>
          POPIA-first · Access-controlled · Audited
        </div>
        <Link href="/" style={{ fontSize: 13, alignSelf: "center" }}>
          ← Back to site
        </Link>
      </form>
    </div>
  );
}
