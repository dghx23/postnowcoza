import { useState } from "react";
import type { GetServerSideProps } from "next";
import { useRouter } from "next/router";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { AppHeader, Card, Stepper, TrackingTimeline } from "@/components/ui";

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
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
          }),
        },
        body: file,
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Upload failed");
      }

      const { id } = await res.json();
      router.push(`/tracking/${id}`);
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

              <div className="field">
                <label>Physical Address</label>
                <input
                  placeholder="Street address"
                  value={streetAddress}
                  onChange={(e) => setStreetAddress(e.target.value)}
                  required
                />
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
