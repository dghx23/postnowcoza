import { useCallback, useEffect, useState } from "react";
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

interface StatusResponse {
  status: string;
  message: string;
  pendingJobs: number;
  connected: boolean;
  productName?: string;
  serialNumber?: string;
  recentJobs?: Array<{
    documentId: string;
    recipientName: string;
    status: "success" | "failed";
    time: string;
  }>;
  today?: { success: number; failed: number; pending?: number };
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

function jobStatusClass(status: string): "success" | "failed" | "pending" {
  if (status === "success" || status === "completed") return "success";
  if (status === "failed" || status === "error_occurred" || status === "expired") return "failed";
  return "pending";
}

export default function PrinterPage({ userLabel }: PrinterPageProps) {
  const [data, setData] = useState<DetailsResponse | null>(null);
  const [hub, setHub] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [provider, setProvider] = useState<"EPSON" | "EPSON_DIRECT" | null>(null);
  const [providerSaving, setProviderSaving] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [epsonDirectEmail, setEpsonDirectEmail] = useState("");
  const [emailSaved, setEmailSaved] = useState(false);
  const [notifSyncing, setNotifSyncing] = useState(false);
  const [notifResult, setNotifResult] = useState<string | null>(null);
  const [notifError, setNotifError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const loadHub = useCallback(async () => {
    try {
      const res = await fetch("/api/epson/status");
      const json = await res.json();
      setHub(json);
      setLastUpdated(new Date());
    } catch {
      setHub({
        status: "unknown",
        message: "Unable to reach status API",
        pendingJobs: 0,
        connected: false,
      });
    }
  }, []);

  const loadDetails = useCallback(async () => {
    try {
      const res = await fetch("/api/epson/details");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load printer details");
      setData(json);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([loadHub(), loadDetails()]);
    setRefreshing(false);
  }, [loadHub, loadDetails]);

  useEffect(() => {
    void refreshAll();
    const interval = setInterval(() => void loadHub(), 30_000);
    return () => clearInterval(interval);
  }, [refreshAll, loadHub]);

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

  async function syncPrintNotifications(includeSeen = false) {
    setNotifSyncing(true);
    setNotifError(null);
    setNotifResult(null);
    try {
      const res = await fetch(
        `/api/epson/notifications/sync${includeSeen ? "?includeSeen=1" : ""}`,
        { method: "POST" },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const diag =
          json.diag && typeof json.diag === "object"
            ? ` [host=${json.diag.host ?? json.diag.imapHost}:${json.diag.port ?? json.diag.imapPort}, userSet=${json.diag.userSet}, passSet=${json.diag.passwordSet}, passLen=${json.diag.passwordLength}]`
            : "";
        throw new Error((json.error ?? `Sync failed (HTTP ${res.status})`) + diag);
      }
      setNotifResult(
        `Fetched ${json.fetched} notification(s), applied ${json.applied} update(s)` +
          (json.transport ? ` via ${json.transport}` : "") +
          ` to print jobs.`,
      );
      await loadHub();
    } catch (err) {
      setNotifError((err as Error).message);
    } finally {
      setNotifSyncing(false);
    }
  }

  const online =
    hub?.status === "online" ||
    hub?.status === "busy" ||
    (hub?.connected === true && hub?.status !== "offline");
  const todayTotal = (hub?.today?.success ?? 0) + (hub?.today?.failed ?? 0);
  const successRate =
    todayTotal === 0 ? null : Math.round(((hub?.today?.success ?? 0) / todayTotal) * 100);
  const productName = hub?.productName ?? data?.device?.productName ?? "—";
  const serial = hub?.serialNumber ?? data?.device?.serialNumber;

  return (
    <div className="app-shell">
      <AppHeader active="printer" userLabel={userLabel} showPrintQueue showRoadmap />
      <main className="app-main printer-hub">
        {/* ═══ HEADER (inspired by Printer Hub mockup) ═══ */}
        <header className="printer-hub-header">
          <div className="printer-hub-logo">
            Post<span>Now</span>
            <small>· Printer Hub</small>
          </div>
          <div className="printer-hub-header-right">
            <span className={`printer-hub-status-dot${online ? "" : " offline"}`}>
              <span className="dot" />
              {online ? (hub?.status === "busy" ? "Busy" : "Online") : hub?.message || "Offline"}
            </span>
            <span className="printer-hub-updated">
              {lastUpdated
                ? `Last updated: ${lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
                : "Updating…"}
            </span>
            <button
              type="button"
              className="printer-hub-refresh"
              disabled={refreshing}
              onClick={() => void refreshAll()}
            >
              {refreshing ? "⏳ Refreshing…" : "↻ Refresh"}
            </button>
            <Link href="/print-queue" className="btn btn-secondary" style={{ fontSize: 13 }}>
              Print Queue →
            </Link>
          </div>
        </header>

        {/* ═══ TOP STATS ═══ */}
        <div className="printer-hub-grid">
          <div className="printer-hub-card">
            <div className="printer-hub-card-title">🖨️ Printer</div>
            <div className="printer-hub-card-number printer-hub-card-name">{productName}</div>
            <div className="printer-hub-card-sub">{serial ? `SN: ${serial}` : "Serial not reported"}</div>
            <div style={{ marginTop: 8 }}>
              <span className={`printer-hub-badge ${online ? "green" : "red"}`}>
                {online ? "● Online" : "● Offline"}
              </span>
              {provider && (
                <span className="printer-hub-badge yellow" style={{ marginLeft: 6 }}>
                  {provider === "EPSON_DIRECT" ? "Email Print" : "Epson Connect"}
                </span>
              )}
            </div>
          </div>
          <div className="printer-hub-card">
            <div className="printer-hub-card-title">📄 Pending Jobs</div>
            <div className="printer-hub-card-number">{hub?.pendingJobs ?? "—"}</div>
            <div className="printer-hub-card-sub">Waiting for confirmation / queue</div>
          </div>
          <div className="printer-hub-card">
            <div className="printer-hub-card-title">📊 Today&apos;s Prints</div>
            <div className="printer-hub-card-number">{todayTotal}</div>
            <div className="printer-hub-card-sub">
              Success rate: {successRate === null ? "—" : `${successRate}%`}
              {hub?.today ? (
                <span style={{ color: "var(--text-muted, #9CA3AF)" }}>
                  {" "}
                  · {hub.today.success} ok / {hub.today.failed} failed
                </span>
              ) : null}
            </div>
          </div>
        </div>

        {/* ═══ RECENT JOBS ═══ */}
        <div className="printer-hub-wide">
          <div className="printer-hub-wide-header">
            <span className="printer-hub-wide-title">📋 Recent Print Jobs</span>
            <span className="printer-hub-wide-meta">Last 10 · from audit trail &amp; email confirmations</span>
          </div>
          {!hub?.recentJobs || hub.recentJobs.length === 0 ? (
            <div style={{ fontSize: 14, color: "#6B7280", padding: "8px 0" }}>
              No print jobs recorded yet. Send a print from the{" "}
              <Link href="/print-queue" style={{ fontWeight: 600, color: "#00A8A8" }}>
                Print Queue
              </Link>
              .
            </div>
          ) : (
            <table className="printer-hub-table">
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Recipient</th>
                  <th>Time</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {hub.recentJobs.map((job, i) => (
                  <tr key={`${job.documentId}-${job.time}-${i}`}>
                    <td>
                      <Link
                        href={`/tracking/${job.documentId}`}
                        style={{ fontWeight: 700, color: "#0A2540", textDecoration: "none" }}
                      >
                        #{job.documentId.slice(0, 10).toUpperCase()}
                      </Link>
                    </td>
                    <td>{job.recipientName}</td>
                    <td>
                      {new Date(job.time).toLocaleString([], {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td>
                      <span className={`printer-hub-job-badge ${jobStatusClass(job.status)}`}>
                        {job.status.toUpperCase()}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="printer-hub-footnote">
          <span>
            <span className="info-icon">i</span>
            Ink &amp; paper levels aren&apos;t available via the Epson Connect API — use the printer&apos;s own
            low-ink alerts.
          </span>
          <span>
            <span className="info-icon">⏱</span>
            Status refreshes every 30 seconds automatically.
          </span>
          <span>
            <span className="info-icon">✉</span>
            Email Print outcomes sync from the Zoho print-agent mailbox (IMAP/POP).
          </span>
        </div>

        {/* ═══ SETTINGS (secondary) ═══ */}
        <Card title="Printing Method">
          <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 12 }}>
            Backend used by Print Queue &quot;Print (API)&quot; / Email to Printer.
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
                <label>Printer&apos;s Epson Email Print address</label>
                <input
                  type="email"
                  placeholder="e.g. postnow@print.epsonconnect.com"
                  value={epsonDirectEmail}
                  onChange={(e) => setEpsonDirectEmail(e.target.value)}
                />
              </div>
              <button type="submit" className="btn btn-secondary" disabled={providerSaving}>
                {emailSaved ? "✓ Saved" : "Save address"}
              </button>
            </form>
          )}
          {providerError && <div className="form-error" style={{ marginTop: 8 }}>{providerError}</div>}
        </Card>

        <Card title="Epson email notifications → platform">
          <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 12 }}>
            Pull completed/error notices from the Zoho print-agent mailbox into print confirmation status.
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={notifSyncing}
              onClick={() => void syncPrintNotifications(false)}
            >
              {notifSyncing ? "Checking mailbox…" : "Check mailbox now"}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={notifSyncing}
              onClick={() => void syncPrintNotifications(true)}
            >
              Re-scan recent (incl. read)
            </button>
          </div>
          {notifResult && (
            <div style={{ marginTop: 12, fontSize: 13, color: "var(--success, #12633f)" }}>{notifResult}</div>
          )}
          {notifError && (
            <div className="form-error" style={{ marginTop: 12, whiteSpace: "pre-wrap" }}>
              {notifError}
            </div>
          )}
        </Card>

        <div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {showAdvanced ? "Hide" : "Show"} advanced Epson Connect details
          </button>
        </div>

        {showAdvanced && (
          <>
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
                    Connect from the Print Queue
                  </Link>
                  .
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
          </>
        )}
      </main>
    </div>
  );
}
