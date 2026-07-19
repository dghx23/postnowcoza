import { useMemo, useState } from "react";
import type { GetServerSideProps } from "next";
import Link from "next/link";
import { useRouter } from "next/router";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/db";
import { AppHeader, StatusPill } from "@/components/ui";

interface TrackRow {
  id: string;
  recipientName: string;
  city: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  returnPreference: "DIRECT" | "MANAGED";
  trackingReference: string | null;
  paymentStatus: string | null;
}

interface TrackingHubProps {
  userLabel: string;
  isStaff: boolean;
  rows: TrackRow[];
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export const getServerSideProps: GetServerSideProps<TrackingHubProps> = async (context) => {
  const session = await getServerSession(context.req, context.res, authOptions);
  if (!session?.user?.email) {
    return { redirect: { destination: "/login", permanent: false } };
  }

  const user = await prisma.user.findUnique({ where: { email: session.user.email } });
  if (!user) return { redirect: { destination: "/login", permanent: false } };

  const isStaff = user.role === "STAFF" || user.role === "ADMIN";
  const where = isStaff ? {} : { ownerId: user.id };

  const documents = await prisma.document.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    take: 100,
    include: {
      bobgoShipments: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { trackingReference: true },
      },
      payments: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { status: true },
      },
    },
  });

  return {
    props: {
      userLabel: `${user.email}${isStaff ? " · Secure Facility" : ""}`,
      isStaff,
      rows: documents.map((d) => ({
        id: d.id,
        recipientName: d.recipientName,
        city: d.city,
        status: d.status,
        createdAt: d.createdAt.toISOString(),
        updatedAt: d.updatedAt.toISOString(),
        returnPreference: d.returnPreference,
        trackingReference: d.bobgoShipments[0]?.trackingReference ?? null,
        paymentStatus: d.payments[0]?.status ?? null,
      })),
    },
  };
};

export default function TrackingHub({ userLabel, isStaff, rows }: TrackingHubProps) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [lookup, setLookup] = useState("");
  const [lookupError, setLookupError] = useState<string | null>(null);

  const statuses = useMemo(() => {
    const set = new Set(rows.map((r) => r.status));
    return ["ALL", ...Array.from(set).sort()];
  }, [rows]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter !== "ALL" && r.status !== statusFilter) return false;
      if (!needle) return true;
      return (
        r.id.toLowerCase().includes(needle) ||
        r.recipientName.toLowerCase().includes(needle) ||
        r.city.toLowerCase().includes(needle) ||
        (r.trackingReference?.toLowerCase().includes(needle) ?? false)
      );
    });
  }, [rows, q, statusFilter]);

  function openLookup(e: React.FormEvent) {
    e.preventDefault();
    setLookupError(null);
    const raw = lookup.trim();
    if (!raw) {
      setLookupError("Enter a reference ID");
      return;
    }
    // Allow full id, short display id, or PN- prefix
    const cleaned = raw.replace(/^#/, "").replace(/^PN-/i, "").toLowerCase();
    const match = rows.find(
      (r) =>
        r.id.toLowerCase() === cleaned ||
        r.id.toLowerCase().startsWith(cleaned) ||
        r.trackingReference?.toLowerCase() === cleaned ||
        r.trackingReference?.toLowerCase().includes(cleaned),
    );
    if (match) {
      void router.push(`/tracking/${match.id}`);
      return;
    }
    // Try navigating by full id if it looks like a cuid
    if (/^c[a-z0-9]{20,}$/i.test(cleaned)) {
      void router.push(`/tracking/${cleaned}`);
      return;
    }
    setLookupError("No matching dispatch in your list — check the ID or use search below.");
  }

  return (
    <div className="app-shell">
      <AppHeader
        active="tracking"
        userLabel={userLabel}
        showPrintQueue={isStaff}
        showRoadmap={isStaff}
      />
      <main className="app-main track-hub">
        <header className="track-hub-header">
          <div>
            <div className="page-title">Tracking</div>
            <div className="page-subtitle">
              {isStaff
                ? "All dispatches — open any reference for live status, payment, and chain of custody."
                : "Your dispatches — open a reference for live status and updates."}
            </div>
          </div>
          <Link href="/dispatch/new" className="btn btn-primary">
            + New Dispatch
          </Link>
        </header>

        <form className="track-lookup" onSubmit={openLookup}>
          <label className="track-lookup-label" htmlFor="track-lookup-input">
            Jump to reference
          </label>
          <div className="track-lookup-row">
            <input
              id="track-lookup-input"
              className="track-lookup-input"
              placeholder="e.g. CMRR6ZT8 or full tracking ID"
              value={lookup}
              onChange={(e) => setLookup(e.target.value)}
              autoComplete="off"
            />
            <button type="submit" className="btn btn-primary">
              Open
            </button>
          </div>
          {lookupError && <div className="form-error">{lookupError}</div>}
        </form>

        <div className="track-filters">
          <input
            className="track-search"
            placeholder="Search recipient, city, or ID…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {s === "ALL" ? "All statuses" : s.replace(/_/g, " ")}
              </option>
            ))}
          </select>
          <span className="track-count">
            {visible.length} of {rows.length}
          </span>
        </div>

        <div className="track-table-wrap">
          {rows.length === 0 ? (
            <div className="track-empty">
              No dispatches yet.{" "}
              <Link href="/dispatch/new" style={{ fontWeight: 600 }}>
                Create a secure dispatch
              </Link>
              .
            </div>
          ) : visible.length === 0 ? (
            <div className="track-empty">No dispatches match your filters.</div>
          ) : (
            <table className="track-table">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Recipient</th>
                  <th>Status</th>
                  <th>Payment</th>
                  <th>Courier</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link href={`/tracking/${r.id}`} className="track-ref">
                        #{r.id.slice(0, 10).toUpperCase()}
                      </Link>
                    </td>
                    <td>
                      <Link href={`/tracking/${r.id}`} className="track-recipient-link">
                        <div className="track-recipient">{r.recipientName}</div>
                        <div className="track-city">{r.city}</div>
                      </Link>
                    </td>
                    <td>
                      <Link href={`/tracking/${r.id}`}>
                        <StatusPill status={r.status} />
                      </Link>
                    </td>
                    <td>
                      {r.paymentStatus ? (
                        <span className={`track-pay track-pay-${r.paymentStatus.toLowerCase()}`}>
                          {r.paymentStatus}
                        </span>
                      ) : (
                        <Link href={`/pay/${r.id}`} className="track-pay-link">
                          Pay fee →
                        </Link>
                      )}
                    </td>
                    <td className="track-courier">
                      {r.trackingReference ? (
                        <span title={r.trackingReference}>{r.trackingReference.slice(0, 14)}</span>
                      ) : (
                        <span className="track-muted">Not booked</span>
                      )}
                    </td>
                    <td className="track-updated" title={new Date(r.updatedAt).toLocaleString()}>
                      {timeAgo(r.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </div>
  );
}
