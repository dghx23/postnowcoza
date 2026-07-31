import { useState } from "react";
import { useRouter } from "next/router";
import Link from "next/link";
import { signIn } from "next-auth/react";

type LoginRole = "ADMIN" | "CUSTOMER";
type Product = "e2" | "express" | "globeme" | "midl";

const PRODUCT_TABS: Array<{ key: Product; label: string }> = [
  { key: "e2", label: "PostNow E2" },
  { key: "express", label: "PostNow Express" },
  { key: "globeme", label: "GlobeMe" },
  { key: "midl", label: "Midl" },
];

const PRODUCT_REDIRECT: Record<Exclude<Product, "midl">, string> = {
  e2: "/dashboard",
  express: "/dashboard/express",
  globeme: "/dashboard/globeme",
};

export default function LoginPage() {
  const router = useRouter();
  const [role, setRole] = useState<LoginRole>("ADMIN");
  const [product, setProduct] = useState<Product>("e2");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isMidl = role === "ADMIN" && product === "midl";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (isMidl) return;
    setSubmitting(true);
    setError(null);

    const result = await signIn("credentials", { email, password, redirect: false });

    setSubmitting(false);
    if (result?.error) {
      setError("Invalid email or password.");
      return;
    }

    if (role === "CUSTOMER") {
      router.push("/portal");
      return;
    }
    router.push(PRODUCT_REDIRECT[product as Exclude<Product, "midl">]);
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={handleSubmit}>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 22, color: "var(--navy-900)" }}>
          Post<span style={{ color: "var(--teal-600)" }}>Now</span> Group
        </div>

        <div className="role-tabs" style={{ display: "flex", gap: 8, marginBottom: 4 }}>
          {(["ADMIN", "CUSTOMER"] as LoginRole[]).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRole(r)}
              className={`btn ${role === r ? "btn-primary" : "btn-outline-dark"}`}
              style={{ flex: 1, padding: "8px 0", fontSize: 13 }}
            >
              {r === "ADMIN" ? "Administrator" : "Customer"}
            </button>
          ))}
        </div>

        {role === "ADMIN" && (
          <div className="product-tabs" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 4 }}>
            {PRODUCT_TABS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setProduct(p.key)}
                className={`product-tab ${product === p.key ? "active" : ""}`}
                style={{
                  flex: "1 1 auto",
                  padding: "6px 10px",
                  fontSize: 12,
                  borderRadius: 6,
                  border: "1px solid var(--border-color, #e5e7eb)",
                  background: product === p.key ? "var(--navy-900)" : "transparent",
                  color: product === p.key ? "#fff" : "var(--text-secondary)",
                  cursor: "pointer",
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}

        <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 20, color: "var(--navy-900)" }}>
          {isMidl ? "Midl" : "Sign in"}
        </div>

        {isMidl ? (
          <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6 }}>
            Midl (escrow + courier for peer-to-peer trade) shares PostNow&apos;s infrastructure but isn&apos;t
            live yet — its admin login will appear here once that integration ships.
          </div>
        ) : (
          <>
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
              {submitting ? "Signing in…" : "Sign in"}
            </button>
          </>
        )}

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
