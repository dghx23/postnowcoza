import { useEffect, useState } from "react";
import type { GetServerSideProps } from "next";
import Link from "next/link";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/db";
import { AppHeader, Card, Badge, DataTable } from "@/components/ui";
import type {
  EpsonDeviceInfo,
  EpsonPrintSettings,
  EpsonPrintCapability,
  EpsonNotificationSettings,
} from "@/lib/epson";

interface PrinterPageProps {
  userLabel: string;
}

export const getServerSideProps: GetServerSideProps<PrinterPageProps> = async (context) => {
  const session = await getServerSession(context.req, context.res, authOptions);
  if (!session?.user?.email) {
    return { redirect: { destination: "/login", permanent: false } };
  }

  const user = await prisma.user.findUnique({ where: { email: session.user.email } });
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return { redirect: { destination: "/dashboard", permanent: false } };
  }

  return { props: { userLabel: `${user.email} · Print Ops` } };
};

interface DetailsResponse {
  connected: boolean;
  device?: EpsonDeviceInfo;
  defaults?: { printSettings: EpsonPrintSettings };
  capability?: { document: EpsonPrintCapability; photo: EpsonPrintCapability };
  notification?: EpsonNotificationSettings;
}

function capabilityRows(capability: EpsonPrintCapability): string[][] {
  const rows: string[][] = [];
  for (const size of capability.paperSizes) {
    for (const type of size.paperTypes) {
      rows.push([
        size.paperSize,
        type.paperType,
        type.borderless ? "Yes" : "No",
        type.paperSources.join(", "),
        type.printQualities.join(", "),
        type.doubleSided ? "Yes" : "No",
      ]);
    }
  }
  return rows;
}

export default function PrinterPage({ userLabel }: PrinterPageProps) {
  const [data, setData] = useState<DetailsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [provider, setProvider] = useState<"EPSON" | "EPSON_DIRECT" | null>(null);
  const [providerSaving, setProviderSaving] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [epsonDirectEmail, setEpsonDirectEmail] = useState("");
  const [emailSaved, setEmailSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/epson/details");
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Failed to load printer details");
        if (!cancelled) setData(json);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    fetch("/api/print-settings")
      .then((res) => res.json())
      .then((json) => {
        setProvider(json.provider ?? "EPSON");
        setEpsonDirectEmail(json.epsonDirectEmail ?? "");
      })
      .catch(() => setProvider("EPSON"));
  }, []);

  async function updateProvider(next: "EPSON" | "EPSON_DIRECT") {
    setProviderSaving(true);
    setProviderError(null);
    try {
      const res = await fetch("/api/print-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: next }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to update printing method");
      setProvider(json.provider);
    } catch (err) {
      setProviderError((err as Error).message);
    } finally {
      setProviderSaving(false);
    }
  }

  async function saveEpsonDirectEmail(e: React.FormEvent) {
    e.preventDefault();
    setProviderSaving(true);
    setProviderError(null);
    setEmailSaved(false);
    try {
      const res = await fetch("/api/print-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ epsonDirectEmail: epsonDirectEmail.trim() || null }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to save printer email");
      setEpsonDirectEmail(json.epsonDirectEmail ?? "");
      setEmailSaved(true);
      setTimeout(() => setEmailSaved(false), 2000);
    } catch (err) {
      setProviderError((err as Error).message);
    } finally {
      setProviderSaving(false);
    }
  }

  return (
    <div className="app-shell">
      <AppHeader active="printer" userLabel={userLabel} showPrintQueue showRoadmap />
      <main className="app-main">
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div>
            <div className="page-title">Printer Details</div>
            <div className="page-subtitle">
              Everything the Epson Connect API reports about the connected printer — identity, current defaults,
              full capability matrix, and notification config.
            </div>
          </div>

          <Card title="Printing Method">
            <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 12 }}>
              Choose which backend the print queue's "Print (API)" button uses. Switching this doesn't affect
              documents already queued or printed.
            </div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <button
                type="button"
                className={provider === "EPSON" ? "btn btn-primary" : "btn btn-secondary"}
                disabled={providerSaving || provider === null}
                onClick={() => updateProvider("EPSON")}
              >
                ☁️ Epson Connect (Cloud)
              </button>
              <button
                type="button"
                className={provider === "EPSON_DIRECT" ? "btn btn-primary" : "btn btn-secondary"}
                disabled={providerSaving || provider === null}
                onClick={() => updateProvider("EPSON_DIRECT")}
              >
                📧 Epson Direct (Email Print)
              </button>
            </div>
            {provider === "EPSON_DIRECT" && (
              <form
                onSubmit={saveEpsonDirectEmail}
                style={{ display: "flex", gap: 12, alignItems: "flex-end", marginTop: 16, flexWrap: "wrap" }}
              >
                <div className="field" style={{ flex: "1 1 280px" }}>
                  <label>Printer's Epson Email Print address</label>
                  <input
                    type="email"
                    placeholder="e.g. abc123xyz@print.epsonconnect.com"
                    value={epsonDirectEmail}
                    onChange={(e) => setEpsonDirectEmail(e.target.value)}
                  />
                </div>
                <button type="submit" className="btn btn-secondary" disabled={providerSaving}>
                  {emailSaved ? "✓ Saved" : "Save address"}
                </button>
              </form>
            )}
            {provider === "EPSON_DIRECT" && (
              <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 12 }}>
                Sending a document to print emails the PDF straight to this address — enable Email Print on the
                printer itself (Epson Connect setup) to find its assigned address. No OAuth connection needed.
              </div>
            )}
            {providerError && <div className="form-error" style={{ marginTop: 8 }}>{providerError}</div>}
          </Card>

          {error && <div className="form-error">{error}</div>}

          {!data ? (
            <Card>
              <div style={{ fontSize: 14, color: "var(--text-secondary)" }}>Loading printer details…</div>
            </Card>
          ) : !data.connected ? (
            <Card>
              <div style={{ fontSize: 14, color: "var(--text-secondary)" }}>
                Not connected to Epson Connect yet.{" "}
                <Link href="/print-queue" style={{ color: "var(--accent-primary)", fontWeight: 600 }}>
                  Connect the printer from the Print Queue
                </Link>{" "}
                first.
              </div>
            </Card>
          ) : (
            <>
              <Card title="Printer Identity">
                <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8 }}>
                  <Badge tone={data.device?.connected ? "success" : "navy"}>
                    {data.device?.connected ? "● Online" : "● Offline"}
                  </Badge>
                  <div style={{ fontWeight: 700 }}>{data.device?.productName ?? "Unknown printer"}</div>
                </div>
                {data.device?.serialNumber && (
                  <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                    Serial number: {data.device.serialNumber}
                  </div>
                )}
              </Card>

              {data.defaults && (
                <Card title="Current Default Print Settings">
                  <DataTable
                    columns={["Setting", "Value"]}
                    rows={Object.entries(data.defaults.printSettings).map(([key, value]) => [
                      key,
                      String(value),
                    ])}
                  />
                </Card>
              )}

              {data.capability?.document && (
                <Card title="Print Capability — Document Mode">
                  <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 12 }}>
                    Color modes: {data.capability.document.colorModes.join(", ")} · Resolutions:{" "}
                    {data.capability.document.resolutions.join(", ")} dpi
                  </div>
                  <DataTable
                    columns={["Paper Size", "Paper Type", "Borderless", "Paper Sources", "Print Qualities", "Duplex"]}
                    rows={capabilityRows(data.capability.document)}
                  />
                </Card>
              )}

              {data.capability?.photo && (
                <Card title="Print Capability — Photo Mode">
                  <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 12 }}>
                    Color modes: {data.capability.photo.colorModes.join(", ")} · Resolutions:{" "}
                    {data.capability.photo.resolutions.join(", ")} dpi
                  </div>
                  <DataTable
                    columns={["Paper Size", "Paper Type", "Borderless", "Paper Sources", "Print Qualities", "Duplex"]}
                    rows={capabilityRows(data.capability.photo)}
                  />
                </Card>
              )}

              {data.notification && (
                <Card title="Notification Settings">
                  <DataTable
                    columns={["Setting", "Value"]}
                    rows={[
                      ["Notifications enabled", data.notification.notification ? "Yes" : "No"],
                      ["Callback URI", data.notification.callbackUri ?? "—"],
                    ]}
                  />
                </Card>
              )}

              <Card>
                <button type="button" className="printer-panel-raw-toggle" onClick={() => setShowRaw((v) => !v)}>
                  {showRaw ? "Hide" : "View"} full raw API response
                </button>
                {showRaw && <pre className="printer-status-raw">{JSON.stringify(data, null, 2)}</pre>}
              </Card>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
