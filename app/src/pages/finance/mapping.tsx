import { useEffect, useState } from "react";
import type { GetServerSideProps } from "next";
import Link from "next/link";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/db";
import { AppHeader, Card, Badge, DataTable } from "@/components/ui";
import { getZohoBooksPublicConfig, zohoBooksAppUrl } from "@/lib/zohoBooks";

interface MappingPageProps {
  userLabel: string;
  zoho: {
    configured: boolean;
    organizationId: string | null;
    region: string;
    appUrl: string | null;
  };
}

interface SyncHistoryEvent {
  id: string;
  action: string;
  createdAt: string;
  documentId: string;
  recipientName: string;
  metadata: Record<string, unknown> | null;
}

interface SyncException {
  id: string;
  source: string;
  severity: string;
  title: string;
  detail: string | null;
  documentId: string | null;
  resolved: boolean;
  createdAt: string;
}

export const getServerSideProps: GetServerSideProps<MappingPageProps> = async (context) => {
  const session = await getServerSession(context.req, context.res, authOptions);
  if (!session?.user?.email) {
    return { redirect: { destination: "/login", permanent: false } };
  }

  const user = await prisma.user.findUnique({ where: { email: session.user.email } });
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return { redirect: { destination: "/dashboard", permanent: false } };
  }

  return {
    props: {
      userLabel: `${user.email} · Finance Mapping`,
      zoho: getZohoBooksPublicConfig(),
    },
  };
};

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function eventLabel(action: string): { label: string; tone: "success" | "danger" | "teal" } {
  if (action === "zoho_books_synced") return { label: "Pushed to Zoho", tone: "success" };
  if (action === "zoho_books_sync_failed") return { label: "Sync failed", tone: "danger" };
  if (action === "zoho_books_paid_inbound") return { label: "Pulled: marked PAID", tone: "teal" };
  return { label: action, tone: "teal" };
}

function severityTone(severity: string): "danger" | "warn" | "teal" {
  if (severity === "error") return "danger";
  if (severity === "warn") return "warn";
  return "teal";
}

export default function FinanceMapping({ userLabel, zoho }: MappingPageProps) {
  const [history, setHistory] = useState<SyncHistoryEvent[] | null>(null);
  const [exceptions, setExceptions] = useState<SyncException[] | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [syncBusy, setSyncBusy] = useState<"push" | "pull" | null>(null);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  async function loadHistory() {
    const res = await fetch("/api/finance/sync-history");
    if (res.ok) setHistory((await res.json()).events);
  }

  async function loadExceptions(all: boolean) {
    const res = await fetch(`/api/finance/exceptions${all ? "?all=1" : ""}`);
    if (res.ok) setExceptions((await res.json()).exceptions);
  }

  useEffect(() => {
    void loadHistory();
    void loadExceptions(showResolved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showResolved]);

  async function resolveException(id: string) {
    await fetch("/api/finance/exceptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, resolve: true }),
    });
    void loadExceptions(showResolved);
  }

  async function runManualSync(kind: "push" | "pull") {
    setSyncBusy(kind);
    setSyncResult(null);
    try {
      const body = kind === "push" ? { allUnsynced: true } : { pullAll: true };
      const res = await fetch("/api/finance/zoho", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setSyncResult(data.error ?? "Sync failed");
      } else if (kind === "push") {
        setSyncResult(`Pushed ${data.count} payment${data.count === 1 ? "" : "s"}.`);
      } else {
        setSyncResult(`Checked ${data.count} linked invoice${data.count === 1 ? "" : "s"}, ${data.changed} newly marked PAID.`);
      }
      void loadHistory();
      void loadExceptions(showResolved);
    } catch (err) {
      setSyncResult((err as Error).message);
    } finally {
      setSyncBusy(null);
    }
  }

  return (
    <div className="app-shell">
      <AppHeader active="finance" userLabel={userLabel} showPrintQueue showFinance showSettings />
      <main className="app-main">
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div className="page-head">
            <div>
              <div className="page-title">Finance Mapping</div>
              <div className="page-subtitle">
                What lives where between PostNow and Zoho Books, how the two-way sync actually works, and the
                tools to run and investigate it.
              </div>
            </div>
            <Badge tone={zoho.configured ? "success" : "danger"}>
              {zoho.configured ? `Zoho connected · Org ${zoho.organizationId}` : "Zoho not configured"}
            </Badge>
          </div>

          <Card title="Where things live">
            <DataTable
              columns={["PostNow", "Zoho Books", "Source of truth", "Notes"]}
              rows={[
                ["Document / dispatch / tracking", "— (not synced)", "PostNow", "Print, courier, and chain-of-custody never touch Zoho at all."],
                ["Recipient name / email / phone", "Contact", "PostNow → Zoho", "Found-or-created by name + email on first push."],
                ["Payment amount, status", "Invoice + Customer Payment", "PostNow → Zoho (push), Zoho → PostNow (pull)", "PostNow creates the invoice; a pull can flip PostNow to PAID."],
                ["BillingItem", "Item", "Staff-mapped", "Linked manually via BillingItem.zohoItemId; not auto-created."],
                ["Payment.zohoBooksInvoiceId / ContactId / PaymentId", "Zoho record IDs", "Zoho (assigned on push)", "Stored back onto the Payment row so future syncs are idempotent."],
                ["Payment.zohoBooksInvoiceStatus / Balance", "Live invoice state", "Zoho", "Only refreshed when a pull runs — not live/real-time."],
                ["SyncException log", "— (PostNow only)", "PostNow", "Zoho has no visibility into our push/pull failures."],
              ]}
            />
          </Card>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
            <Card title="Push flow — PostNow → Zoho">
              <ol className="mapping-flow-list">
                <li>A Payment reaches <strong>PAID</strong> in PostNow (PayFast ITN, or staff marks it paid).</li>
                <li>Find-or-create a Zoho <strong>Contact</strong> from the recipient's name/email/phone.</li>
                <li>Create a Zoho <strong>Invoice</strong> if one isn't already linked (line description includes the BillingItem name and document reference).</li>
                <li>If the Payment is PAID, record a <strong>Customer Payment</strong> against that invoice.</li>
                <li>Store the returned contact/invoice/payment IDs back on the Payment row.</li>
                <li>On any failure: log a <Badge tone="danger">SyncException</Badge> (source <code>zoho_push</code>) and an audit event.</li>
              </ol>
            </Card>
            <Card title="Pull flow — Zoho → PostNow">
              <ol className="mapping-flow-list">
                <li>Fetch the linked Zoho invoice's live status and balance.</li>
                <li>Store the latest status/balance on the Payment row regardless of outcome.</li>
                <li>If Zoho shows <strong>paid</strong> and PostNow still shows UNPAID, and the amounts match within R0.05 → auto-flip to PAID + audit event.</li>
                <li>If the amounts <strong>don't</strong> match → do not auto-mark paid; log a <Badge tone="warn">warn</Badge> exception for manual review instead.</li>
                <li>On fetch failure: log a <Badge tone="danger">SyncException</Badge> (source <code>zoho_pull</code>).</li>
              </ol>
            </Card>
          </div>

          <Card title="Scheduling">
            <p style={{ margin: "0 0 8px", fontSize: 14, color: "var(--text-secondary)" }}>
              There is <strong>no automatic schedule</strong> for Zoho Books sync yet — every push and pull above is
              triggered manually, either per-payment from the Financial ledger or in bulk from the buttons below.
              This is a known gap (see Roadmap: "Zoho Books Vercel env").
            </p>
            <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>
              For comparison, the Epson email-notification sync <em>does</em> run on a schedule
              (<code>/api/epson/notifications/sync</code> — daily via Vercel cron, every 5 minutes via a GitHub
              Actions workflow) — the same pattern could be reused here if Zoho sync needs to stop being manual-only.
            </p>
          </Card>

          <Card title="Manual sync">
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!zoho.configured || syncBusy !== null}
                onClick={() => void runManualSync("push")}
              >
                {syncBusy === "push" ? "Pushing…" : "⬆ Push all unsynced"}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={!zoho.configured || syncBusy !== null}
                onClick={() => void runManualSync("pull")}
              >
                {syncBusy === "pull" ? "Pulling…" : "⬇ Pull all linked"}
              </button>
              {zoho.appUrl && (
                <a href={zoho.appUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13 }}>
                  Open Zoho Books →
                </a>
              )}
            </div>
            {!zoho.configured && (
              <p style={{ marginTop: 10, fontSize: 13, color: "var(--text-muted)" }}>
                Zoho Books isn't configured yet — set <code>ZOHO_BOOKS_*</code> env vars in Vercel first (see Roadmap).
              </p>
            )}
            {syncResult && <p style={{ marginTop: 10, fontSize: 13 }}>{syncResult}</p>}
          </Card>

          <Card title="Sync history">
            {history === null ? (
              <p style={{ fontSize: 14, color: "var(--text-secondary)" }}>Loading…</p>
            ) : history.length === 0 ? (
              <p style={{ fontSize: 14, color: "var(--text-secondary)" }}>No Zoho sync activity yet.</p>
            ) : (
              <DataTable
                columns={["When", "Event", "Document", "Detail"]}
                rows={history.map((e) => {
                  const { label, tone } = eventLabel(e.action);
                  const detail =
                    e.action === "zoho_books_sync_failed"
                      ? String((e.metadata as { error?: string } | null)?.error ?? "")
                      : e.action === "zoho_books_synced"
                        ? String((e.metadata as { invoiceId?: string } | null)?.invoiceId ?? "")
                        : e.action === "zoho_books_paid_inbound"
                          ? `R ${(e.metadata as { amount?: number } | null)?.amount ?? ""}`
                          : "";
                  return [
                    timeAgo(e.createdAt),
                    <Badge key={`${e.id}-tone`} tone={tone}>{label}</Badge>,
                    <Link key={`${e.id}-doc`} href={`/tracking/${e.documentId}`} style={{ color: "inherit" }}>
                      {e.recipientName}
                    </Link>,
                    <span key={`${e.id}-detail`} style={{ fontSize: 12, color: "var(--text-muted)" }}>{detail}</span>,
                  ];
                })}
              />
            )}
          </Card>

          <Card title="Exceptions — highlighting & investigation">
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 13, display: "inline-flex", alignItems: "center", gap: 6 }}>
                <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
                Include resolved
              </label>
            </div>
            {exceptions === null ? (
              <p style={{ fontSize: 14, color: "var(--text-secondary)" }}>Loading…</p>
            ) : exceptions.length === 0 ? (
              <p style={{ fontSize: 14, color: "var(--text-secondary)" }}>No exceptions to show.</p>
            ) : (
              <DataTable
                columns={["When", "Severity", "Source", "Title", "Document", "Action"]}
                rows={exceptions.map((ex) => [
                  timeAgo(ex.createdAt),
                  <Badge key={`${ex.id}-sev`} tone={severityTone(ex.severity)}>{ex.severity}</Badge>,
                  ex.source,
                  <div key={`${ex.id}-title`}>
                    <div>{ex.title}</div>
                    {ex.detail && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{ex.detail}</div>}
                  </div>,
                  ex.documentId ? (
                    <Link key={`${ex.id}-doc`} href={`/tracking/${ex.documentId}`} style={{ color: "inherit" }}>
                      Investigate →
                    </Link>
                  ) : (
                    "—"
                  ),
                  ex.resolved ? (
                    <Badge key={`${ex.id}-resolved`} tone="success">Resolved</Badge>
                  ) : (
                    <button
                      key={`${ex.id}-resolve`}
                      type="button"
                      className="btn btn-secondary"
                      style={{ fontSize: 12, padding: "6px 12px" }}
                      onClick={() => void resolveException(ex.id)}
                    >
                      Mark resolved
                    </button>
                  ),
                ])}
              />
            )}
          </Card>
        </div>
      </main>
    </div>
  );
}
