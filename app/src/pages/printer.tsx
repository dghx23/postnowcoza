import { useCallback, useEffect, useState } from "react";
import type { GetServerSideProps } from "next";
import Link from "next/link";
import { useRouter } from "next/router";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/db";
import { AppHeader, Card, Badge, DataTable, Alert } from "@/components/ui";
import type {
  EpsonDeviceInfo,
  EpsonPrintSettings,
  EpsonPrintCapability,
  EpsonNotificationSettings,
} from "@/lib/epson";
import {
  PAPER_SIZES,
  PAPER_TYPES,
  PRINT_QUALITIES,
  PAPER_SOURCES,
  DOUBLE_SIDED,
} from "@/lib/printJobSettings";

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
  authorized?: boolean;
  deviceOnline?: boolean;
  device?: EpsonDeviceInfo;
  defaults?: { printSettings: EpsonPrintSettings };
  capability?: { document: EpsonPrintCapability; photo?: EpsonPrintCapability };
  notification?: EpsonNotificationSettings | null;
  error?: string;
}

interface StatusResponse {
  status: string;
  message: string;
  pendingJobs: number;
  /** OAuth tokens stored — not the same as printer network online. */
  authorized?: boolean;
  connected: boolean;
  reachability?: "unlinked" | "online" | "offline" | "error";
  productName?: string;
  serialNumber?: string;
  recentJobs?: Array<{
    documentId: string;
    recipientName: string;
    status: "success" | "failed" | "pending" | "attention";
    time: string;
    via?: string | null;
    viaLabel?: string;
    jobId?: string;
    customerColor?: string | null;
    printedColor?: string | null;
    customerCopies?: number | null;
    printedCopies?: number | null;
    pages?: number | null;
    paperSize?: string | null;
    quality?: string | null;
    hasIssue?: boolean;
    issueLabel?: string | null;
    comment?: string | null;
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

function jobStatusClass(status: string): "success" | "failed" | "pending" | "attention" {
  if (status === "success" || status === "completed") return "success";
  if (status === "failed" || status === "error_occurred" || status === "expired" || status === "canceled")
    return "failed";
  if (status === "attention") return "attention";
  return "pending";
}

export default function PrinterPage({ userLabel }: PrinterPageProps) {
  const router = useRouter();
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
  const [printPaperSize, setPrintPaperSize] = useState("ps_a4");
  const [printPaperType, setPrintPaperType] = useState("pt_plainpaper");
  const [printQuality, setPrintQuality] = useState("normal");
  const [printPaperSource, setPrintPaperSource] = useState("rear");
  const [printBorderless, setPrintBorderless] = useState(false);
  const [printDoubleSided, setPrintDoubleSided] = useState("none");
  const [defaultsSaved, setDefaultsSaved] = useState(false);
  const [notifConfiguring, setNotifConfiguring] = useState(false);
  const [notifConfigError, setNotifConfigError] = useState<string | null>(null);
  const [webhookUri, setWebhookUri] = useState<string | null>(null);
  const [webhookPanelOpen, setWebhookPanelOpen] = useState(true);
  const [emailNotifPanelOpen, setEmailNotifPanelOpen] = useState(true);
  const [notifSyncing, setNotifSyncing] = useState(false);
  const [notifResult, setNotifResult] = useState<string | null>(null);
  const [notifError, setNotifError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [hubLoading, setHubLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [epsonBanner, setEpsonBanner] = useState<"connected" | "error" | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  const loadHub = useCallback(async (opts?: { quiet?: boolean }) => {
    if (!opts?.quiet) setHubLoading(true);
    try {
      // Fast status only — no IMAP on the poll path.
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
        authorized: false,
        reachability: "error",
      });
    } finally {
      setHubLoading(false);
    }
  }, []);

  const loadDetails = useCallback(async () => {
    try {
      const res = await fetch("/api/epson/details");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load printer details");
      setData(json);
      setError(null);
      // Open advanced panel automatically once linked.
      if (json.connected) setShowAdvanced(true);
      // Keep job webhooks always on when Connect is linked.
      if (json.connected && json.notification?.notification !== true) {
        void fetch("/api/epson/notifications/configure", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        })
          .then((r) => r.json())
          .then((cfg) => {
            if (cfg.ok || cfg.notification) {
              setWebhookUri(cfg.registeredCallbackUri ?? cfg.callbackUri ?? null);
              setData((prev) =>
                prev
                  ? {
                      ...prev,
                      notification: {
                        notification: true,
                        callbackUri: cfg.callbackUri ?? cfg.registeredCallbackUri ?? prev.notification?.callbackUri,
                      },
                    }
                  : prev
              );
            }
          })
          .catch(() => {
            /* non-fatal — status strip will show if still off */
          });
      } else if (json.notification?.callbackUri) {
        setWebhookUri(json.notification.callbackUri);
      }
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
    // Quiet polls so the header doesn't flash "Refreshing…" every 30s.
    const interval = setInterval(() => void loadHub({ quiet: true }), 30_000);
    return () => clearInterval(interval);
  }, [refreshAll, loadHub]);

  useEffect(() => {
    if (!router.isReady) return;
    const epson = router.query.epson;
    if (epson === "connected" || epson === "error") {
      setEpsonBanner(epson);
      // Drop query so a refresh doesn't re-show the banner forever.
      void router.replace("/printer", undefined, { shallow: true });
      if (epson === "connected") void refreshAll();
    }
  }, [router.isReady, router.query.epson, router, refreshAll]);

  useEffect(() => {
    fetch("/api/print-settings")
      .then((res) => res.json())
      .then((json) => {
        setProvider(json.provider ?? "EPSON");
        setEpsonDirectEmail(json.epsonDirectEmail ?? "");
        setPrintPaperSize(json.printPaperSize ?? "ps_a4");
        setPrintPaperType(json.printPaperType ?? "pt_plainpaper");
        setPrintQuality(json.printQuality ?? "normal");
        setPrintPaperSource(json.printPaperSource ?? "rear");
        setPrintBorderless(Boolean(json.printBorderless));
        setPrintDoubleSided(json.printDoubleSided ?? "none");
      })
      .catch(() => setProvider("EPSON"));
  }, []);

  async function saveFacilityPrintDefaults(e: React.FormEvent) {
    e.preventDefault();
    setProviderSaving(true);
    setProviderError(null);
    setDefaultsSaved(false);
    try {
      const res = await fetch("/api/print-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          printPaperSize,
          printPaperType,
          printQuality,
          printPaperSource,
          printBorderless,
          printDoubleSided,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to save print defaults");
      setPrintPaperSize(json.printPaperSize);
      setPrintPaperType(json.printPaperType);
      setPrintQuality(json.printQuality);
      setPrintPaperSource(json.printPaperSource);
      setPrintBorderless(json.printBorderless);
      setPrintDoubleSided(json.printDoubleSided);
      setDefaultsSaved(true);
      setTimeout(() => setDefaultsSaved(false), 2000);
    } catch (err) {
      setProviderError((err as Error).message);
    } finally {
      setProviderSaving(false);
    }
  }

  async function handleDisconnectEpson() {
    setDisconnecting(true);
    try {
      const res = await fetch("/api/epson/disconnect", { method: "POST" });
      if (!res.ok) throw new Error((await res.json()).error ?? "Disconnect failed");
      setData({ connected: false });
      await loadHub();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDisconnecting(false);
    }
  }

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

  async function configureWebhooks(enabled: boolean) {
    setNotifConfiguring(true);
    setNotifConfigError(null);
    try {
      const res = await fetch("/api/epson/notifications/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (json.error ?? (enabled ? "Could not enable webhooks" : "Could not disable webhooks")) +
            (json.detail ? ` — ${typeof json.detail === "string" ? json.detail : JSON.stringify(json.detail)}` : ""),
        );
      }
      setWebhookUri(json.registeredCallbackUri ?? json.recommendedCallbackUri ?? json.callbackUri ?? null);
      await loadDetails();
    } catch (err) {
      setNotifConfigError((err as Error).message);
    } finally {
      setNotifConfiguring(false);
    }
  }

  async function ensureWebhooksOn() {
    return configureWebhooks(true);
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

  // Unified view: hub poll + details snapshot (details can fill identity while hub loads).
  const epsonLinked =
    hub?.authorized === true ||
    data?.authorized === true ||
    data?.connected === true ||
    Boolean(hub?.productName) ||
    Boolean(data?.device?.productName);

  const deviceOnline =
    hub?.status === "online" ||
    hub?.status === "busy" ||
    hub?.connected === true ||
    data?.deviceOnline === true ||
    // truthy connected on device payload from details
    data?.device?.connected === true;

  const busy = hub?.status === "busy";
  const statusLabel = !epsonLinked
    ? "Not linked"
    : hubLoading && !hub
      ? "Checking…"
      : busy
        ? "Busy"
        : deviceOnline
          ? "Online"
          : hub?.reachability === "error"
            ? "API error"
            : "Offline";
  const statusTone =
    !epsonLinked || hub?.reachability === "error"
      ? "red"
      : deviceOnline || busy
        ? "green"
        : "amber";

  const todayTotal = (hub?.today?.success ?? 0) + (hub?.today?.failed ?? 0);
  const successRate =
    todayTotal === 0 ? null : Math.round(((hub?.today?.success ?? 0) / todayTotal) * 100);
  const productName = hub?.productName ?? data?.device?.productName ?? (epsonLinked ? "Printer" : "—");
  const serial = hub?.serialNumber ?? data?.device?.serialNumber;
  const pendingJobs = hub?.pendingJobs ?? 0;

  return (
    <div className="app-shell">
      <AppHeader active="printer" userLabel={userLabel} showPrintQueue showRoadmap />
      <main className="app-main printer-hub">
        {/* ═══ HEADER ═══ */}
        <header className="printer-hub-header">
          <div className="printer-hub-logo">
            Post<span>Now</span>
            <small>· Printer Hub</small>
          </div>
          <div className="printer-hub-header-right">
            <span className={`printer-hub-status-dot tone-${statusTone}`}>
              <span className="dot" />
              {statusLabel}
              {productName && productName !== "—" ? ` · ${productName}` : ""}
            </span>
            <span className="printer-hub-updated">
              {lastUpdated
                ? `Updated ${lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
                : hubLoading
                  ? "Loading status…"
                  : "—"}
            </span>
            <button
              type="button"
              className="printer-hub-refresh"
              disabled={refreshing}
              onClick={() => void refreshAll()}
            >
              {refreshing ? "Refreshing…" : "↻ Refresh"}
            </button>
            {epsonLinked ? (
              <button
                type="button"
                className="btn btn-secondary"
                style={{ fontSize: 13 }}
                disabled={disconnecting}
                onClick={() => void handleDisconnectEpson()}
              >
                {disconnecting ? "Disconnecting…" : "Disconnect"}
              </button>
            ) : (
              <a href="/api/epson/connect" className="btn btn-primary" style={{ fontSize: 13 }}>
                Connect Epson
              </a>
            )}
            <Link href="/print-queue" className="btn btn-secondary" style={{ fontSize: 13 }}>
              Print Queue →
            </Link>
          </div>
        </header>

        {epsonBanner === "connected" && (
          <Alert title="Epson Connect linked">
            Device authorized. Tokens are stored server-side so any staff browser can print with{" "}
            <strong>Print EpsonAPI</strong>.
          </Alert>
        )}
        {epsonBanner === "error" && (
          <Alert title="Epson Connect failed" tone="danger">
            Could not complete OAuth. Check EPSON_CLIENT_ID / CLIENT_SECRET / API_KEY / REDIRECT_URI in
            Vercel (exact match to the Epson developer console, no extra spaces), then try Connect again.
          </Alert>
        )}

        {/* ═══ CONNECTION STRIP ═══ */}
        <div className="epson-conn-strip">
          <div className="epson-conn-item">
            <span className="epson-conn-label">Account</span>
            <span className={`epson-conn-value ${epsonLinked ? "ok" : "bad"}`}>
              {epsonLinked ? "● Linked" : "○ Not linked"}
            </span>
          </div>
          <div className="epson-conn-item">
            <span className="epson-conn-label">Device</span>
            <span className={`epson-conn-value tone-${statusTone}`}>
              ● {statusLabel}
            </span>
          </div>
          <div className="epson-conn-item">
            <span className="epson-conn-label">Model</span>
            <span className="epson-conn-value">{productName}</span>
          </div>
          <div className="epson-conn-item">
            <span className="epson-conn-label">Serial</span>
            <span className="epson-conn-value mono">{serial ?? "—"}</span>
          </div>
          <div className="epson-conn-item grow">
            <span className="epson-conn-label">Status message</span>
            <span className="epson-conn-value muted">
              {hub?.message ?? (hubLoading ? "Checking Epson Connect…" : "—")}
            </span>
          </div>
          {!epsonLinked && (
            <a href="/api/epson/connect" className="btn btn-primary epson-conn-cta">
              Connect Epson Connect
            </a>
          )}
        </div>

        {/* ═══ TOP STATS ═══ */}
        <div className="printer-hub-grid">
          <div className="printer-hub-card">
            <div className="printer-hub-card-title">🖨️ Printer</div>
            <div className="printer-hub-card-number printer-hub-card-name">
              {hubLoading && !hub && !data ? "…" : productName}
            </div>
            <div className="printer-hub-card-sub">
              {serial ? `SN: ${serial}` : epsonLinked ? "Serial not reported" : "Connect to load identity"}
            </div>
            <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
              <span className={`printer-hub-badge ${statusTone === "green" ? "green" : statusTone === "amber" ? "yellow" : "red"}`}>
                ● {statusLabel}
              </span>
              {epsonLinked && (
                <span className="printer-hub-badge teal">Epson Connect</span>
              )}
              {provider && (
                <span className="printer-hub-badge yellow">
                  Hub default: {provider === "EPSON_DIRECT" ? "EpsonMail" : "EpsonAPI"}
                </span>
              )}
            </div>
          </div>
          <div className="printer-hub-card">
            <div className="printer-hub-card-title">📄 Pending Jobs</div>
            <div className="printer-hub-card-number">
              {hubLoading && hub == null ? "…" : pendingJobs}
            </div>
            <div className="printer-hub-card-sub">Waiting for confirmation / queue</div>
          </div>
          <div className="printer-hub-card">
            <div className="printer-hub-card-title">📊 Today&apos;s Prints</div>
            <div className="printer-hub-card-number">
              {hubLoading && hub == null ? "…" : todayTotal}
            </div>
            <div className="printer-hub-card-sub">
              Success rate: {hubLoading && hub == null ? "…" : successRate === null ? "—" : `${successRate}%`}
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
            <span className="printer-hub-wide-meta">
              Platform submissions · colour / copies / pages · issues flagged
            </span>
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
            <div className="printer-hub-table-scroll">
              <table className="printer-hub-table printer-hub-table-detail">
                <thead>
                  <tr>
                    <th>Document</th>
                    <th>Recipient</th>
                    <th>Channel</th>
                    <th>Colour</th>
                    <th>Copies</th>
                    <th>Pages</th>
                    <th>Paper</th>
                    <th>Time</th>
                    <th>Status</th>
                    <th>Issues</th>
                  </tr>
                </thead>
                <tbody>
                  {hub.recentJobs.map((job, i) => {
                    const isManual = job.viaLabel === "MANUAL" || job.via === "manual_mark";
                    return (
                      <tr
                        key={`${job.documentId}-${job.time}-${i}`}
                        className={isManual ? "printer-hub-row-manual" : job.hasIssue ? "printer-hub-row-issue" : undefined}
                      >
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
                          <span className={`pq-channel${isManual ? " manual" : ""}`}>
                            {job.viaLabel ?? "Print"}
                          </span>
                        </td>
                        <td>
                          <span title="Customer → printed">
                            {job.customerColor ?? "—"}
                            {job.printedColor && job.printedColor !== job.customerColor
                              ? ` → ${job.printedColor}`
                              : ""}
                          </span>
                        </td>
                        <td>
                          {job.printedCopies ?? job.customerCopies ?? "—"}
                          {job.customerCopies != null &&
                          job.printedCopies != null &&
                          job.customerCopies !== job.printedCopies
                            ? ` (req ${job.customerCopies})`
                            : ""}
                        </td>
                        <td>{job.pages != null ? job.pages : isManual ? "—" : "—"}</td>
                        <td>
                          {[job.paperSize, job.quality].filter(Boolean).join(" · ") || "—"}
                        </td>
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
                            {job.status === "success"
                              ? isManual
                                ? "MANUAL OK"
                                : "SUCCESS"
                              : job.status === "attention"
                                ? "ATTENTION"
                                : job.status === "pending"
                                  ? "PENDING"
                                  : "FAILED"}
                          </span>
                        </td>
                        <td>
                          {job.hasIssue ? (
                            <span className="printer-hub-issue-flag" title={job.issueLabel ?? "Issue"}>
                              ⚠ {job.issueLabel ?? "Issue"}
                            </span>
                          ) : job.comment ? (
                            <span className="printer-hub-comment" title={job.comment}>
                              💬 note
                            </span>
                          ) : (
                            <span className="printer-hub-ok">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
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
        <Card title="Print Queue defaults">
          <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 12 }}>
            Hub default for bulk tooling. Each queue row still offers both{" "}
            <strong>Print EpsonAPI</strong> (cloud) and <strong>Print EpsonMail</strong> (email).
          </div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <button
              type="button"
              className={provider === "EPSON" ? "btn btn-primary" : "btn btn-secondary"}
              disabled={providerSaving || provider === null}
              onClick={() => updateProvider("EPSON")}
            >
              ☁️ EpsonAPI (Connect cloud)
            </button>
            <button
              type="button"
              className={provider === "EPSON_DIRECT" ? "btn btn-primary" : "btn btn-secondary"}
              disabled={providerSaving || provider === null}
              onClick={() => updateProvider("EPSON_DIRECT")}
            >
              📧 EpsonMail (Email Print)
            </button>
          </div>
          <form
            onSubmit={saveEpsonDirectEmail}
            style={{ display: "flex", gap: 12, alignItems: "flex-end", marginTop: 16, flexWrap: "wrap" }}
          >
            <div className="field" style={{ flex: "1 1 280px" }}>
              <label>Printer&apos;s Epson Email Print address (for EpsonMail)</label>
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
          {providerError && <div className="form-error" style={{ marginTop: 8 }}>{providerError}</div>}
        </Card>

        <Card title="Default print settings (manual adjusters)">
          <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 12 }}>
            Facility defaults for Epson Connect jobs. Customers choose <strong>colour</strong> and{" "}
            <strong>copies</strong> on New Dispatch; staff can override everything in the print
            confirmation dialog.
          </div>
          <form onSubmit={saveFacilityPrintDefaults}>
            <div className="print-defaults-grid">
              <div className="field">
                <label>Paper size</label>
                <select value={printPaperSize} onChange={(e) => setPrintPaperSize(e.target.value)}>
                  {PAPER_SIZES.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Paper type</label>
                <select value={printPaperType} onChange={(e) => setPrintPaperType(e.target.value)}>
                  {PAPER_TYPES.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Print quality</label>
                <select value={printQuality} onChange={(e) => setPrintQuality(e.target.value)}>
                  {PRINT_QUALITIES.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Paper source</label>
                <select value={printPaperSource} onChange={(e) => setPrintPaperSource(e.target.value)}>
                  {PAPER_SOURCES.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Double-sided</label>
                <select value={printDoubleSided} onChange={(e) => setPrintDoubleSided(e.target.value)}>
                  {DOUBLE_SIDED.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              <label className="checkbox-row" style={{ alignItems: "center", marginTop: 22 }}>
                <input
                  type="checkbox"
                  checked={printBorderless}
                  onChange={(e) => setPrintBorderless(e.target.checked)}
                />
                Borderless
              </label>
            </div>
            <div style={{ marginTop: 14 }}>
              <button type="submit" className="btn btn-primary" disabled={providerSaving}>
                {defaultsSaved ? "✓ Defaults saved" : "Save print defaults"}
              </button>
            </div>
          </form>
        </Card>

        {/* Side-by-side collapsers: Connect job webhooks | Email mailbox sync */}
        <div className="epson-notif-pair">
          <section className="epson-notif-panel card">
            <button
              type="button"
              className="epson-notif-panel-toggle"
              aria-expanded={webhookPanelOpen}
              onClick={() => setWebhookPanelOpen((v) => !v)}
            >
              <span className="epson-notif-panel-chevron" aria-hidden>
                {webhookPanelOpen ? "▾" : "▸"}
              </span>
              <span
                className={`epson-webhook-dot${
                  data?.notification?.notification ? " on" : hub?.authorized || data?.connected ? " off" : ""
                }`}
              />
              <span className="epson-notif-panel-title">
                Epson Connect job webhooks
                <span className="epson-notif-panel-sub">Print EpsonAPI outcomes</span>
              </span>
            </button>
            {webhookPanelOpen && (
              <div className="epson-notif-panel-body">
                <p className="epson-notif-panel-desc">
                  Right now Epson has notifications off until you enable them. Click{" "}
                  <strong>Enable &amp; register callback</strong> so completed / failed / delayed jobs POST into
                  PostNow (tracking, queue, audit). This is the cloud equivalent of mailbox sync for Print
                  EpsonAPI.
                </p>
                <table className="epson-notif-settings-table">
                  <tbody>
                    <tr>
                      <th scope="row">Setting</th>
                      <th scope="row">Value</th>
                    </tr>
                    <tr>
                      <td>Notifications enabled</td>
                      <td>
                        <strong>
                          {data?.notification?.notification
                            ? "Yes"
                            : hub?.authorized || data?.connected
                              ? notifConfiguring
                                ? "…"
                                : "No"
                              : "— (link Connect first)"}
                        </strong>
                      </td>
                    </tr>
                    <tr>
                      <td>Callback URI</td>
                      <td className="epson-notif-mono">
                        {data?.notification?.callbackUri ||
                          webhookUri ||
                          "https://app.postnow.co.za/api/epson/job-webhook"}
                      </td>
                    </tr>
                  </tbody>
                </table>
                <div className="epson-notif-panel-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ fontSize: 13 }}
                    disabled={notifConfiguring || !(hub?.authorized || data?.connected)}
                    onClick={() => void configureWebhooks(true)}
                  >
                    {notifConfiguring ? "Working…" : "Enable & register callback"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ fontSize: 13 }}
                    disabled={notifConfiguring || !data?.notification?.notification}
                    onClick={() => void configureWebhooks(false)}
                  >
                    Disable
                  </button>
                </div>
                <p className="epson-notif-panel-foot">
                  After deploy, this endpoint must return JSON on GET:{" "}
                  <code>/api/epson/job-webhook</code>. Optional Vercel env{" "}
                  <code>EPSON_WEBHOOK_SECRET</code> adds <code>?key=…</code> for security.
                </p>
                {notifConfigError && (
                  <div className="form-error" style={{ marginTop: 10, whiteSpace: "pre-wrap" }}>
                    {notifConfigError}
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="epson-notif-panel card">
            <button
              type="button"
              className="epson-notif-panel-toggle"
              aria-expanded={emailNotifPanelOpen}
              onClick={() => setEmailNotifPanelOpen((v) => !v)}
            >
              <span className="epson-notif-panel-chevron" aria-hidden>
                {emailNotifPanelOpen ? "▾" : "▸"}
              </span>
              <span className="epson-notif-panel-title">
                Email print notifications → platform
                <span className="epson-notif-panel-sub">EpsonMail / owner email</span>
              </span>
            </button>
            {emailNotifPanelOpen && (
              <div className="epson-notif-panel-body">
                <p className="epson-notif-panel-desc">
                  Pull completed/error notices from the Zoho print-agent mailbox (for Email Print and owner
                  emails). Separate from Connect webhooks on the left.
                </p>
                <div className="epson-notif-panel-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ fontSize: 13 }}
                    disabled={notifSyncing}
                    onClick={() => void syncPrintNotifications(false)}
                  >
                    {notifSyncing ? "Checking mailbox…" : "Check mailbox now"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    style={{ fontSize: 13 }}
                    disabled={notifSyncing}
                    onClick={() => void syncPrintNotifications(true)}
                  >
                    Re-scan recent (incl. read)
                  </button>
                </div>
                {notifResult && (
                  <div style={{ marginTop: 12, fontSize: 13, color: "var(--success, #12633f)" }}>
                    {notifResult}
                  </div>
                )}
                {notifError && (
                  <div className="form-error" style={{ marginTop: 12, whiteSpace: "pre-wrap" }}>
                    {notifError}
                  </div>
                )}
              </div>
            )}
          </section>
        </div>

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
                  Not linked to Epson Connect yet.{" "}
                  <a href="/api/epson/connect" style={{ color: "var(--accent-primary)", fontWeight: 600 }}>
                    Connect Epson Connect
                  </a>{" "}
                  to authorize a printer for this facility.
                </div>
              </Card>
            ) : (
              <>
                <Card title="Printer Identity">
                  <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
                    <Badge tone={data.deviceOnline || data.device?.connected ? "success" : "navy"}>
                      {data.deviceOnline || data.device?.connected ? "● Online" : "● Offline / sleeping"}
                    </Badge>
                    <Badge tone="teal">Linked</Badge>
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
