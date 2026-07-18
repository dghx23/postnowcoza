import Link from "next/link";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

type NavKey = "dashboard" | "dispatch" | "tracking" | "print-queue" | "roadmap" | "printer";

export function AppHeader({
  active,
  userLabel,
  showPrintQueue,
  showRoadmap,
}: {
  active: NavKey;
  userLabel: string;
  showPrintQueue?: boolean;
  showRoadmap?: boolean;
}) {
  const items: Array<{ key: NavKey; label: string; href: string }> = [
    { key: "dashboard", label: "Dashboard", href: "/dashboard" },
    { key: "dispatch", label: "New Dispatch", href: "/dispatch/new" },
    { key: "tracking", label: "Tracking", href: "/dashboard" },
    ...(showPrintQueue ? [{ key: "print-queue" as const, label: "Print Queue", href: "/print-queue" }] : []),
    ...(showPrintQueue ? [{ key: "printer" as const, label: "Printer", href: "/printer" }] : []),
    ...(showRoadmap ? [{ key: "roadmap" as const, label: "Roadmap", href: "/roadmap" }] : []),
  ];

  return (
    <header className="app-header">
      <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 20 }}>
          Post<span style={{ color: "var(--teal-400)" }}>Now</span>
          <span className="e2-tag" style={{ marginLeft: 6 }}>E2</span>
        </div>
        <nav>
          {items.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              className={`nav-pill${item.key === active ? " active" : ""}`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
        <div style={{ fontSize: 13, color: "rgba(255,255,255,.75)" }}>{userLabel}</div>
        <Link href="/" style={{ fontSize: 13, color: "rgba(255,255,255,.75)" }}>
          Exit to site
        </Link>
      </div>
    </header>
  );
}

export function MetricTile({ label, value, tone }: { label: string; value: string; tone: "teal" | "navy" | "gold" }) {
  return (
    <div className={`metric-tile tone-${tone}`}>
      <div className="value">{value}</div>
      <div className="label">{label}</div>
    </div>
  );
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="card">
      {title && <div className="card-title">{title}</div>}
      {children}
    </div>
  );
}

export function Alert({
  title,
  children,
  tone = "success",
}: {
  title: string;
  children: ReactNode;
  tone?: "success" | "danger";
}) {
  return (
    <div className={`alert alert-${tone}`}>
      <div className="alert-title">{title}</div>
      <div className="alert-body">{children}</div>
    </div>
  );
}

export function Badge({ children, tone }: { children: ReactNode; tone: "teal" | "navy" | "success" }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function StatusPill({ status }: { status: string }) {
  const label = status
    .toLowerCase()
    .split("_")
    .join(" ")
    .replace(/^./, (c) => c.toUpperCase());
  return <span className={`status-pill status-${status.toLowerCase()}`}>{label}</span>;
}

export function DataTable({ columns, rows }: { columns: string[]; rows: ReactNode[][] }) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            {row.map((cell, j) => (
              <td key={j}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface TimelineEvent {
  label: string;
  time?: string;
  state: "done" | "current" | "pending";
}

export function TrackingTimeline({ events }: { events: TimelineEvent[] }) {
  return (
    <div className="timeline">
      {events.map((event, i) => (
        <div key={i} className={`timeline-item ${event.state}`}>
          <div className="timeline-dot" />
          <div>
            <div className="timeline-label">{event.label}</div>
            {event.time && <div className="timeline-time">{event.time}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

interface RecentJob {
  documentId: string;
  recipientName: string;
  status: "success" | "failed";
  time: string;
}

interface PrinterStatusData {
  status: "online" | "busy" | "offline" | "not_connected" | "unknown";
  message: string;
  pendingJobs: number;
  productName?: string;
  serialNumber?: string;
  recentJobs?: RecentJob[];
  today?: { success: number; failed: number };
  raw?: unknown;
}

// Polls /api/epson/status every 30s. Staff-facing only — mounted on pages
// already gated to STAFF/ADMIN, so no extra auth check needed here. Click
// the summary line to open a small dashboard panel: printer identity,
// pending/today counters, and real print history from our own audit trail
// (not just Epson's own job list, which only knows about jobs it still has
// on record).
export function PrinterStatus() {
  const [data, setData] = useState<PrinterStatusData | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch("/api/epson/status");
        const json = await res.json();
        if (!cancelled) {
          setData(json);
          setLastUpdated(new Date());
        }
      } catch {
        if (!cancelled) setData({ status: "unknown", message: "Unable to reach printer", pendingJobs: 0 });
      }
    }

    poll();
    const interval = setInterval(poll, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (!data) {
    return (
      <div className="printer-status">
        <span className="printer-status-dot unknown" />
        Checking printer…
      </div>
    );
  }

  const todayTotal = (data.today?.success ?? 0) + (data.today?.failed ?? 0);
  const successRate = todayTotal === 0 ? null : Math.round(((data.today?.success ?? 0) / todayTotal) * 100);

  return (
    <details className="printer-status-details">
      <summary className="printer-status">
        <span className={`printer-status-dot ${data.status}`} />
        {data.message}
        {data.productName && ` · ${data.productName}`}
      </summary>

      <div className="printer-panel">
        <div className="printer-panel-grid">
          <div className="printer-mini-card">
            <div className="printer-mini-title">🖨️ Printer</div>
            <div className="printer-mini-value">{data.productName ?? "Not connected"}</div>
            {data.serialNumber && <div className="printer-mini-sub">SN: {data.serialNumber}</div>}
            <Badge tone={data.status === "online" || data.status === "busy" ? "success" : "navy"}>
              {data.status === "online" ? "● Online" : data.status === "busy" ? "● Busy" : "● Offline"}
            </Badge>
          </div>
          <div className="printer-mini-card">
            <div className="printer-mini-title">📄 Pending Jobs</div>
            <div className="printer-mini-value">{data.pendingJobs}</div>
            <div className="printer-mini-sub">Waiting in queue</div>
          </div>
          <div className="printer-mini-card">
            <div className="printer-mini-title">📊 Today's Prints</div>
            <div className="printer-mini-value">{todayTotal}</div>
            <div className="printer-mini-sub">
              {successRate === null ? "No prints yet" : `Success rate: ${successRate}%`}
            </div>
          </div>
        </div>

        <div className="printer-jobs-title">Recent Print Jobs</div>
        {!data.recentJobs || data.recentJobs.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>No print jobs recorded yet.</div>
        ) : (
          <table className="data-table printer-jobs-table">
            <thead>
              <tr>
                <th>Document</th>
                <th>Time</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.recentJobs.map((job, i) => (
                <tr key={i}>
                  <td>
                    <div>{job.recipientName}</div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      #{job.documentId.slice(0, 8).toUpperCase()}
                    </div>
                  </td>
                  <td>{new Date(job.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
                  <td>
                    <Badge tone={job.status === "success" ? "success" : "navy"}>
                      {job.status === "success" ? "Success" : "Failed"}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="printer-panel-footnote">
          <span>ⓘ Ink &amp; paper levels aren't available via the Epson API — rely on the printer's own low-ink alerts.</span>
          <span>
            {lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString()}` : ""} · refreshes every 30s
          </span>
          <button type="button" className="printer-panel-raw-toggle" onClick={() => setShowRaw((v) => !v)}>
            {showRaw ? "Hide" : "View"} raw API response
          </button>
        </div>
        <Link href="/printer" className="printer-panel-details-link">
          View full printer details (capabilities, defaults, notifications) →
        </Link>
        {showRaw && data.raw !== undefined && (
          <pre className="printer-status-raw">{JSON.stringify(data.raw, null, 2)}</pre>
        )}
      </div>
    </details>
  );
}

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">{title}</div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Stepper({ steps, activeIndex }: { steps: string[]; activeIndex: number }) {
  return (
    <div className="stepper">
      {steps.map((step, i) => (
        <div
          key={step}
          className={`stepper-step ${i === activeIndex ? "active" : i < activeIndex ? "done" : ""}`}
        >
          {step}
        </div>
      ))}
    </div>
  );
}
