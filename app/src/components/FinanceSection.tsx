import Link from "next/link";
import type { FinanceSummary } from "@/lib/finance";
import { formatZar, paymentStatusLabel } from "@/lib/finance";
import { Card } from "@/components/ui";

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

/**
 * Role-aware financial UI.
 * - staff: full facility revenue / outstanding / ledger
 * - customer: personal billing (amounts due + history)
 *
 * Future: staff can move to /finance (full view); customer keeps a slim
 * billing card on dashboard or /billing.
 */
export function FinanceSection({ finance }: { finance: FinanceSummary }) {
  if (finance.scope === "customer") {
    return <CustomerFinance finance={finance} />;
  }
  return <StaffFinance finance={finance} />;
}

function StaffFinance({ finance }: { finance: FinanceSummary }) {
  return (
    <section className="finance-section finance-section-staff" aria-labelledby="finance-heading">
      <div className="finance-section-header">
        <div>
          <h2 id="finance-heading" className="finance-section-title">
            <span className="finance-icon" aria-hidden>
              💰
            </span>{" "}
            Financial
          </h2>
          <p className="finance-section-sub">
            Facility-wide payments · staff only · full ledger view
          </p>
        </div>
        <span className="finance-scope-badge staff">Staff full view</span>
      </div>

      <div className="finance-metrics">
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
      </div>

      <div className="finance-table-wrap">
        <div className="finance-table-head">
          <span className="finance-table-title">Recent payments</span>
          <span className="finance-table-hint">Click a row to open tracking / pay context</span>
        </div>
        {finance.recentPayments.length === 0 ? (
          <div className="finance-empty">No payment records yet.</div>
        ) : (
          <table className="finance-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Request</th>
                <th>Recipient</th>
                <th>Customer</th>
                <th>Method</th>
                <th>Status</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {finance.recentPayments.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link href={`/tracking/${p.documentId}`} className="finance-row-link">
                      {timeAgo(p.updatedAt)}
                    </Link>
                  </td>
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
                    <Link
                      href={p.status === "UNPAID" ? `/pay/${p.documentId}` : `/tracking/${p.documentId}`}
                      className="finance-row-link finance-amount"
                    >
                      {formatZar(p.amount)}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function CustomerFinance({ finance }: { finance: FinanceSummary }) {
  const hasDue = finance.unpaidCount > 0;

  return (
    <section className="finance-section finance-section-customer" aria-labelledby="billing-heading">
      <Card>
        <div className="finance-section-header finance-section-header-card">
          <div>
            <h2 id="billing-heading" className="finance-section-title">
              <span className="finance-icon" aria-hidden>
                💳
              </span>{" "}
              Billing &amp; payments
            </h2>
            <p className="finance-section-sub">Your dispatch fees only — not facility revenue</p>
          </div>
          <span className="finance-scope-badge customer">Customer view</span>
        </div>

        <div className="finance-metrics finance-metrics-customer">
          <div className={`finance-metric${hasDue ? " warn" : ""}`}>
            <span className="finance-metric-value">{formatZar(finance.outstanding)}</span>
            <span className="finance-metric-label">
              Amount due · {finance.unpaidCount} open
            </span>
          </div>
          <div className="finance-metric">
            <span className="finance-metric-value">{formatZar(finance.paidAllTime)}</span>
            <span className="finance-metric-label">
              Total paid · {finance.paidCount} payment{finance.paidCount === 1 ? "" : "s"}
            </span>
          </div>
          <div className="finance-metric">
            <span className="finance-metric-value">{formatZar(finance.paidMonth, 0)}</span>
            <span className="finance-metric-label">Paid this month</span>
          </div>
        </div>

        {hasDue && (
          <p className="finance-callout">
            You have outstanding dispatch fees. Pay from tracking or the links below so we can book
            next-day collection after print.
          </p>
        )}

        {finance.recentPayments.length === 0 ? (
          <div className="finance-empty">No payments yet. Fees appear when a dispatch is rated.</div>
        ) : (
          <ul className="finance-customer-list">
            {finance.recentPayments.map((p) => (
              <li key={p.id} className="finance-customer-item">
                <div className="finance-customer-main">
                  <Link href={`/tracking/${p.documentId}`} className="finance-doc-id">
                    #{p.shortId}
                  </Link>
                  <span className="finance-customer-recip">{p.recipientName}</span>
                  <span className={`finance-status ${statusClass(p.status)}`}>
                    {paymentStatusLabel(p.status)}
                  </span>
                </div>
                <div className="finance-customer-side">
                  <span className="finance-amount">{formatZar(p.amount)}</span>
                  {p.status === "UNPAID" ? (
                    <Link href={`/pay/${p.documentId}`} className="btn btn-primary finance-pay-btn">
                      Pay now
                    </Link>
                  ) : (
                    <Link href={`/tracking/${p.documentId}`} className="finance-row-link finance-muted">
                      View
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
