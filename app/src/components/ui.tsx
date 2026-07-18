import Link from "next/link";
import type { ReactNode } from "react";

type NavKey = "dashboard" | "dispatch" | "tracking" | "print-queue";

export function AppHeader({
  active,
  userLabel,
  showPrintQueue,
}: {
  active: NavKey;
  userLabel: string;
  showPrintQueue?: boolean;
}) {
  const items: Array<{ key: NavKey; label: string; href: string }> = [
    { key: "dashboard", label: "Dashboard", href: "/dashboard" },
    { key: "dispatch", label: "New Dispatch", href: "/dispatch/new" },
    { key: "tracking", label: "Tracking", href: "/dashboard" },
    ...(showPrintQueue ? [{ key: "print-queue" as const, label: "Print Queue", href: "/print-queue" }] : []),
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

export function Alert({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="alert alert-success">
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
