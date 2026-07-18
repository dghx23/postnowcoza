import { useRef, useState } from "react";
import type { GetServerSideProps } from "next";
import { useRouter } from "next/router";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { AppHeader, Card, Stepper, TrackingTimeline } from "@/components/ui";
import type { AddressSuggestion } from "@/pages/api/geocode/autocomplete";

export const getServerSideProps: GetServerSideProps<{ userLabel: string }> = async (context) => {
  const session = await getServerSession(context.req, context.res, authOptions);
  if (!session?.user?.email) {
    return { redirect: { destination: "/login", permanent: false } };
  }
  return { props: { userLabel: session.user.email } };
};

const STEPS = ["Submission", "Secure Intake", "Dispatch", "Delivery", "Return", "Record"];
const PENDING_EVENTS = [
  { label: "Submitted", state: "pending" as const },
  { label: "Printed", state: "pending" as const },
  { label: "Dispatched", state: "pending" as const },
  { label: "Delivered", state: "pending" as const },
];

export default function NewDispatch({ userLabel }: { userLabel: string }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [recipientName, setRecipientName] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");
  const [streetAddress, setStreetAddress] = useState("");
  const [localArea, setLocalArea] = useState("");
  const [city, setCity] = useState("");
  const [zone, setZone] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [returnPreference, setReturnPreference] = useState<"DIRECT" | "MANAGED">("MANAGED");
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleStreetAddressChange(value: string) {
    setStreetAddress(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (value.trim().length < 3) {
      setSuggestions([]);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/geocode/autocomplete?q=${encodeURIComponent(value)}`);
        const data = await res.json();
        setSuggestions(data.suggestions ?? []);
        setShowSuggestions(true);
      } catch {
        setSuggestions([]);
      }
    }, 350);
  }

  function selectSuggestion(s: AddressSuggestion) {
    setStreetAddress(s.streetAddress);
    setLocalArea(s.localArea);
    setCity(s.city);
    setZone(s.zone);
    setPostalCode(s.postalCode);
    setSuggestions([]);
    setShowSuggestions(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setError("Attach the document to dispatch.");
      return;
    }
    if (!confirmed) {
      setError("Confirm this dispatch is authorized and POPIA-compliant.");
      return;
    }
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/documents/upload", {
        method: "POST",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "x-filename": file.name,
          "x-delivery-address": JSON.stringify({
            recipientName,
            recipientEmail,
            recipientPhone,
            streetAddress,
            localArea,
            city,
            zone,
            postalCode,
            returnPreference,
          }),
        },
        body: file,
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Upload failed");
      }

      const { id } = await res.json();
      router.push(`/tracking/${id}?submitted=1`);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <div className="app-shell">
      <AppHeader active="dispatch" userLabel={userLabel} />
      <main className="app-main">
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div>
            <div className="page-title">Create New Secure Dispatch</div>
            <div className="page-subtitle">Secure Physical Document Dispatch</div>
          </div>

          <Stepper steps={STEPS} activeIndex={0} />

          <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
            <div style={{ flex: 2, display: "flex", flexDirection: "column", gap: 20 }}>
              <label className={`dropzone${file ? " has-file" : ""}`}>
                {file ? file.name : "Drag & drop your wet-ink signature document here, or click to choose a file"}
                <input
                  type="file"
                  style={{ display: "none" }}
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </label>

              <div className="field-row">
                <div className="field">
                  <label>Recipient Name / Organisation</label>
                  <input value={recipientName} onChange={(e) => setRecipientName(e.target.value)} required />
                </div>
              </div>

              <div className="field" style={{ position: "relative" }}>
                <label>Physical Address</label>
                <input
                  placeholder="Start typing an address…"
                  value={streetAddress}
                  onChange={(e) => handleStreetAddressChange(e.target.value)}
                  onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
                  onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                  autoComplete="off"
                  required
                />
                {showSuggestions && suggestions.length > 0 && (
                  <ul className="address-suggestions">
                    {suggestions.map((s, i) => (
                      <li key={i}>
                        <button type="button" onMouseDown={() => selectSuggestion(s)}>
                          {s.displayName}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="field-row">
                <div className="field">
                  <label>Suburb</label>
                  <input value={localArea} onChange={(e) => setLocalArea(e.target.value)} required />
                </div>
                <div className="field">
                  <label>City</label>
                  <input value={city} onChange={(e) => setCity(e.target.value)} required />
                </div>
              </div>
              <div className="field-row">
                <div className="field">
                  <label>Province</label>
                  <input value={zone} onChange={(e) => setZone(e.target.value)} required />
                </div>
                <div className="field">
                  <label>Postal Code</label>
                  <input value={postalCode} onChange={(e) => setPostalCode(e.target.value)} required />
                </div>
              </div>

              <div className="field-row">
                <div className="field">
                  <label>Email</label>
                  <input
                    type="email"
                    value={recipientEmail}
                    onChange={(e) => setRecipientEmail(e.target.value)}
                    required
                  />
                </div>
                <div className="field">
                  <label>Mobile</label>
                  <input value={recipientPhone} onChange={(e) => setRecipientPhone(e.target.value)} required />
                </div>
              </div>

              <div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: "var(--text-primary)" }}>
                  Return Preference
                </div>
                <div className="radio-cards">
                  <label className={`radio-card${returnPreference === "DIRECT" ? " selected" : ""}`}>
                    <input
                      type="radio"
                      name="returnPreference"
                      checked={returnPreference === "DIRECT"}
                      onChange={() => setReturnPreference("DIRECT")}
                      style={{ marginTop: 3 }}
                    />
                    <div>
                      <div className="radio-card-title">A. Direct Return</div>
                      <div className="radio-card-desc">Facilitated collection with a prepaid courier sticker.</div>
                    </div>
                  </label>
                  <label className={`radio-card${returnPreference === "MANAGED" ? " selected" : ""}`}>
                    <input
                      type="radio"
                      name="returnPreference"
                      checked={returnPreference === "MANAGED"}
                      onChange={() => setReturnPreference("MANAGED")}
                      style={{ marginTop: 3 }}
                    />
                    <div>
                      <div className="radio-card-title">
                        B. Fully Managed Return <span className="radio-card-badge">Recommended</span>
                      </div>
                      <div className="radio-card-desc">via PostNow E2</div>
                    </div>
                  </label>
                </div>
              </div>

              <label className="checkbox-row">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                I confirm this dispatch is authorized and POPIA-compliant
              </label>

              {error && <div className="form-error">{error}</div>}

              <button type="submit" className="btn btn-primary btn-full" disabled={submitting}>
                {submitting ? "Submitting…" : "Submit Secure Dispatch Request"}
              </button>
            </div>

            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 16 }}>
              <Card title="Real-time Tracking">
                <TrackingTimeline events={PENDING_EVENTS} />
              </Card>
              <Card title="Secure Facility">
                <img
                  src="/assets/e2-facility-dashboard.jpg"
                  alt="PostNow E2 secure facility"
                  style={{ width: "100%", borderRadius: "var(--radius-md)", display: "block" }}
                />
              </Card>
            </div>
          </div>
        </form>
      </main>
    </div>
  );
}
