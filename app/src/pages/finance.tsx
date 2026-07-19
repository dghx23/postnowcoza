import { useMemo, useState } from "react";
import type { GetServerSideProps } from "next";
import Link from "next/link";
import { useRouter } from "next/router";
import { getServerSession } from "next-auth/next";
import type { PaymentStatus } from "@prisma/client";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/db";
import { AppHeader } from "@/components/ui";
import {
  getFinanceSummary,
  formatZar,
  paymentStatusLabel,
  type FinanceSummary,
  type FinanceStatusFilter,
} from "@/lib/finance";
import { getZohoBooksPublicConfig, zohoBooksAppUrl } from "@/lib/zohoBooks";

interface FinancePageProps {
  userLabel: string;
  finance: FinanceSummary;
  statusFilter: FinanceStatusFilter;
  zoho: {
    configured: boolean;
    organizationId: string | null;
    region: string;
    appUrl: string | null;
  };
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

function statusClass(status: string): string {
  if (status === "PAID") return "paid";
  if (status === "UNPAID") return "due";
  if (status === "FAILED") return "failed";
  if (status === "REFUNDED") return "refunded";
  return "muted";
}

const STATUS_TABS: Array<{ key: FinanceStatusFilter; label: string }> = [
  { key: "ALL", label: "All" },
  { key: "UNPAID", label: "Due" },
  { key: "PAID", label: "Paid" },
  { key: "FAILED", label: "Failed" },
  { key: "CANCELLED", label: "Cancelled" },
  { key: "REFUNDED", label: "Refunded" },
];

export const getServerSideProps: GetServerSideProps<FinancePageProps> = async (context) => {
  const session = await getServerSession(context.req, context.res, authOptions);
  if (!session?.user?.email) {
    return { redirect: { destination: "/login", permanent: false } };
  }

  const user = await prisma.user.findUnique({ where: { email: session.user.email } });
  if (!user) return { redirect: { destination: "/login", permanent: false } };

  const isStaff = user.role === "STAFF" || user.role === "ADMIN";
  // Full ledger is staff-only for now. Customers keep billing on the dashboard.
  if (!isStaff) {
    return { redirect: { destination: "/dashboard#billing", permanent: false } };
  }

  const raw = typeof context.query.status === "string" ? context.query.status.toUpperCase() : "ALL";
  const allowed: FinanceStatusFilter[] = ["ALL", "UNPAID", "PAID", "FAILED", "CANCELLED", "REFUNDED"];
  const statusFilter = (allowed.includes(raw as FinanceStatusFilter) ? raw : "ALL") as FinanceStatusFilter;

  const finance = await getFinanceSummary({
    ownerId: null,
    recentLimit: 200,
    statusFilter,
  });

  return {
    props: {
      userLabel: `${user.email} · Finance`,
      finance,
      statusFilter,
      zoho: getZohoBooksPublicConfig(),
    },
  };
};

export default function FinancePage({ userLabel, finance, statusFilter, zoho }: FinancePageProps) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return finance.recentPayments;
    return finance.recentPayments.filter(
      (p) =>
        p.recipientName.toLowerCase().includes(q) ||
        (p.ownerEmail ?? "").toLowerCase().includes(q) ||
        p.documentId.toLowerCase().includes(q) ||
        p.shortId.toLowerCase().includes(q) ||
        (p.paymentMethod ?? "").toLowerCase().includes(q) ||
        p.status.toLowerCase().includes(q)
    );
  }, [finance.recentPayments, search]);

  function setStatus(next: FinanceStatusFilter) {
    void router.push(next === "ALL" ? "/finance" : `/finance?status=${next}`);
  }

  async function syncOne(paymentId: string) {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await fetch("/api/finance/zoho", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? json.reason ?? "Sync failed");
      setSyncMsg(json.skipped ? `Already in Zoho Books` : `Synced to Zoho Books`);
      router.replace(router.asPath);
    } catch (err) {
      setSyncMsg((err as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  async function syncAllUnsynced() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await fetch("/api/finance/zoho", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allUnsynced: true }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Bulk sync failed");
      setSyncMsg(`Synced ${json.count ?? 0} paid payment(s) to Zoho Books`);
      router.replace(router.asPath);
    } catch (err) {
      setSyncMsg((err as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  const listSum = rows.reduce((s, p) => s + p.amount, 0);

  return (
    <div className="app-shell">
      <AppHeader active="finance" userLabel={userLabel} showPrintQueue showRoadmap />
      <main className="app-main finance-page">
        <header className="finance-page-header">
          <div>
            <div className="page-title">
              <span aria-hidden>💰</span> Financial
            </div>
            <div className="page-subtitle">
              Facility-wide payments · staff only · mapped to Zoho Books
            </div>
          </div>
          <div className="finance-page-header-actions">
            <span className="finance-scope-badge staff">Staff full view</span>
            {zoho.configured && zoho.appUrl ? (
              <a
                href={zoho.appUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-primary"
                style={{ fontSize: 13 }}
              >
                Open Zoho Books ↗
              </a>
            ) : (
              <span className="finance-zoho-hint" title="Set ZOHO_BOOKS_* env vars in Vercel">
                Zoho Books not configured
              </span>
            )}
            {zoho.configured && (
              <button
                type="button"
                className="btn btn-secondary"
                style={{ fontSize: 13 }}
                disabled={syncing}
                onClick={() => void syncAllUnsynced()}
              >
                {syncing ? "Syncing…" : "Sync paid → Books"}
              </button>
            )}
            <Link href="/dashboard#finance" className="btn btn-secondary" style={{ fontSize: 13 }}>
              ← Dashboard
            </Link>
          </div>
        </header>

        {syncMsg && <p className="finance-sync-msg">{syncMsg}</p>}

        <div className="finance-zoho-bar">
          <span className={`finance-zoho-pill${zoho.configured ? " on" : ""}`}>
            {zoho.configured ? "● Zoho Books linked" : "○ Zoho Books not linked"}
          </span>
          <span className="finance-zoho-meta">
            Paid dispatch fees create a contact + invoice (+ payment when paid) in Zoho Books.
            {zoho.organizationId ? ` Org ${zoho.organizationId}` : ""}
          </span>
          {zoho.configured && zoho.appUrl && (
            <a href={zoho.appUrl} target="_blank" rel="noopener noreferrer" className="finance-inline-link">
              books.zoho →
            </a>
          )}
        </div>

        <div className="finance-metrics finance-metrics-page">
          <div className="finance-metric">
            <span className="finance-metric-value">{formatZar(finance.paidToday, 0)}</span>
            <span className="finance-metric-label">Paid today</span>
          </div>
          <div className="finance-metric">
            <span className="finance-metric-value">{formatZar(finance.paidMonth, 0)}</span>
            <span className="finance-metric-label">Paid this month</span>
          </div>
          <div className="finance-metric">
            <span className="finance-metric-value">{formatZar(finance.paidAllTime, 0)}</span>
            <span className="finance-metric-label">
              All-time paid · {finance.paidCount} txn{finance.paidCount === 1 ? "" : "s"}
            </span>
          </div>
          <div className={`finance-metric${finance.outstanding > 0 ? " warn" : ""}`}>
            <span className="finance-metric-value">{formatZar(finance.outstanding, 0)}</span>
            <span className="finance-metric-label">
              Outstanding · {finance.unpaidCount} open
            </span>
          </div>
          {finance.failedCount > 0 && (
            <div className="finance-metric danger">
              <span className="finance-metric-value">{finance.failedCount}</span>
              <span className="finance-metric-label">Failed payments</span>
            </div>
          )}
          {finance.refundedCount > 0 && (
            <div className="finance-metric">
              <span className="finance-metric-value">{finance.refundedCount}</span>
              <span className="finance-metric-label">Refunded</span>
            </div>
          )}
        </div>

        <section className="finance-ledger" aria-labelledby="ledger-heading">
          <div className="finance-ledger-head">
            <div>
              <h2 id="ledger-heading" className="finance-ledger-title">
                Payment ledger
              </h2>
              <p className="finance-ledger-sub">
                {rows.length} shown
                {statusFilter !== "ALL" ? ` · filter: ${paymentStatusLabel(statusFilter as PaymentStatus)}` : ""}
                {rows.length > 0 ? ` · list total ${formatZar(listSum)}` : ""}
              </p>
            </div>
            <div className="finance-ledger-tools">
              <input
                type="search"
                className="finance-search"
                placeholder="Search recipient, customer, request ID…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search payments"
              />
            </div>
          </div>

          <div className="finance-tabs" role="tablist" aria-label="Filter by status">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={statusFilter === tab.key}
                className={`finance-tab${statusFilter === tab.key ? " active" : ""}`}
                onClick={() => setStatus(tab.key)}
              >
                {tab.label}
                {tab.key === "UNPAID" && finance.unpaidCount > 0 ? ` (${finance.unpaidCount})` : ""}
                {tab.key === "FAILED" && finance.failedCount > 0 ? ` (${finance.failedCount})` : ""}
              </button>
            ))}
          </div>

          {rows.length === 0 ? (
            <div className="finance-empty">No payments match this filter.</div>
          ) : (
            <div className="finance-table-scroll">
              <table className="finance-table finance-table-page">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Request</th>
                    <th>Recipient</th>
                    <th>Customer</th>
                    <th>Method</th>
                    <th>Status</th>
                    <th className="num">Amount</th>
                    <th>Zoho Books</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.id}>
                      <td title={new Date(p.updatedAt).toLocaleString()}>{timeAgo(p.updatedAt)}</td>
                      <td>
                        <Link href={`/tracking/${p.documentId}`} className="finance-doc-id">
                          #{p.shortId}
                        </Link>
                      </td>
                      <td>
                        <Link href={`/tracking/${p.documentId}`} className="finance-row-link">
                          {p.recipientName}
                        </Link>
                      </td>
                      <td className="finance-muted">{p.ownerEmail ?? "—"}</td>
                      <td className="finance-muted">{p.paymentMethod ?? "—"}</td>
                      <td>
                        <span className={`finance-status ${statusClass(p.status)}`}>
                          {paymentStatusLabel(p.status)}
                        </span>
                      </td>
                      <td className="num">
                        <span className="finance-amount">{formatZar(p.amount)}</span>
                      </td>
                      <td>
                        {p.zohoBooksInvoiceId ? (
                          <a
                            href={zohoBooksAppUrl(p.zohoBooksInvoiceId)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="finance-action-link"
                            title={p.zohoBooksSyncedAt ? `Synced ${p.zohoBooksSyncedAt}` : "Open invoice"}
                          >
                            Invoice ↗
                          </a>
                        ) : p.zohoBooksSyncError ? (
                          <span className="finance-status failed" title={p.zohoBooksSyncError}>
                            Sync error
                          </span>
                        ) : (
                          <span className="finance-muted">—</span>
                        )}
                      </td>
                      <td>
                        <div className="finance-row-actions">
                          <Link href={`/tracking/${p.documentId}`} className="finance-action-link">
                            Tracking
                          </Link>
                          {p.status === "UNPAID" && (
                            <Link href={`/pay/${p.documentId}`} className="finance-action-link pay">
                              Collect
                            </Link>
                          )}
                          {zoho.configured && (
                            <button
                              type="button"
                              className="finance-action-link"
                              style={{
                                background: "none",
                                border: "none",
                                padding: 0,
                                cursor: syncing ? "wait" : "pointer",
                                font: "inherit",
                              }}
                              disabled={syncing}
                              onClick={() => void syncOne(p.id)}
                            >
                              Sync
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <p className="finance-page-footnote">
          PayFast ITN updates payment status automatically. Outstanding fees are billed per dispatch.
          Customer-facing billing stays limited to each customer&apos;s own payments on their dashboard.
        </p>
      </main>
    </div>
  );
}
