import { useEffect, useMemo, useState } from "react";
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

interface BillingItemRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  amount: number;
  zohoItemId: string | null;
  active: boolean;
  notes: string | null;
}

interface ScanRow {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  comments: string | null;
  createdBy: string | null;
  createdAt: string;
}

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
  billingItems: BillingItemRow[];
  scans: ScanRow[];
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

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const b64 = result.includes(",") ? result.split(",")[1] : result;
      resolve(b64);
    };
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
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

  const [billingItems, scans] = await Promise.all([
    prisma.billingItem.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    prisma.facilityScan.findMany({ orderBy: { createdAt: "desc" }, take: 30 }),
  ]);

  return {
    props: {
      userLabel: `${user.email} · Finance`,
      finance,
      statusFilter,
      zoho: getZohoBooksPublicConfig(),
      billingItems: billingItems.map((b) => ({
        id: b.id,
        code: b.code,
        name: b.name,
        description: b.description,
        amount: b.amount,
        zohoItemId: b.zohoItemId,
        active: b.active,
        notes: b.notes,
      })),
      scans: scans.map((s) => ({
        id: s.id,
        fileName: s.fileName,
        contentType: s.contentType,
        sizeBytes: s.sizeBytes,
        comments: s.comments,
        createdBy: s.createdBy,
        createdAt: s.createdAt.toISOString(),
      })),
    },
  };
};

export default function FinancePage({
  userLabel,
  finance,
  statusFilter,
  zoho,
  billingItems: initialBilling,
  scans: initialScans,
}: FinancePageProps) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const [billingItems, setBillingItems] = useState(initialBilling);
  const [biCode, setBiCode] = useState("DISPATCH");
  const [biName, setBiName] = useState("Secure dispatch fee");
  const [biAmount, setBiAmount] = useState("149");
  const [biNotes, setBiNotes] = useState("");
  const [biBusy, setBiBusy] = useState(false);
  const [biMsg, setBiMsg] = useState<string | null>(null);

  const [scans, setScans] = useState(initialScans);
  const [scanFile, setScanFile] = useState<File | null>(null);
  const [scanFileName, setScanFileName] = useState("");
  const [scanComments, setScanComments] = useState("");
  const [scanBusy, setScanBusy] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [emailScanId, setEmailScanId] = useState<string | null>(null);
  const [emailTo, setEmailTo] = useState("");
  const [emailSubject, setEmailSubject] = useState("PostNow facility scan");
  const [emailBody, setEmailBody] = useState(
    "Please find the attached scan from PostNow facility ops."
  );
  const [emailPassword, setEmailPassword] = useState("");
  const [encryptOn, setEncryptOn] = useState(false);

  useEffect(() => {
    setBillingItems(initialBilling);
  }, [initialBilling]);
  useEffect(() => {
    setScans(initialScans);
  }, [initialScans]);

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
        p.status.toLowerCase().includes(q) ||
        (p.zohoBooksInvoiceStatus ?? "").toLowerCase().includes(q) ||
        (p.billingItemCode ?? "").toLowerCase().includes(q)
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
      setSyncMsg(json.skipped ? `Already in Zoho Books` : `Pushed to Zoho Books`);
      router.replace(router.asPath);
    } catch (err) {
      setSyncMsg((err as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  async function pullOne(paymentId: string) {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await fetch("/api/finance/zoho", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pull: true, paymentId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? json.reason ?? "Pull failed");
      if (json.skipped) setSyncMsg(`Skipped: ${json.reason ?? "no linked invoice"}`);
      else if (json.localStatusChanged) setSyncMsg(`Zoho paid → PostNow marked PAID`);
      else setSyncMsg(`Pulled Zoho status: ${json.zohoStatus ?? "ok"}`);
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
      setSyncMsg(`Pushed ${json.count ?? 0} paid payment(s) → Zoho Books`);
      router.replace(router.asPath);
    } catch (err) {
      setSyncMsg((err as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  async function pullAll() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await fetch("/api/finance/zoho", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pullAll: true }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Bulk pull failed");
      setSyncMsg(
        `Refreshed ${json.count ?? 0} from Zoho · ${json.changed ?? 0} auto-marked PAID`
      );
      router.replace(router.asPath);
    } catch (err) {
      setSyncMsg((err as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  async function addBillingItem() {
    setBiBusy(true);
    setBiMsg(null);
    try {
      const res = await fetch("/api/finance/billing-items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: biCode,
          name: biName,
          amount: Number(biAmount),
          notes: biNotes || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not save");
      setBillingItems((prev) => [...prev, json.item]);
      setBiMsg("Billing line saved — will map into entries and Zoho when linked.");
      setBiNotes("");
    } catch (err) {
      setBiMsg((err as Error).message);
    } finally {
      setBiBusy(false);
    }
  }

  async function toggleBillingActive(id: string, active: boolean) {
    const res = await fetch("/api/finance/billing-items", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, active: !active }),
    });
    if (res.ok) {
      const json = await res.json();
      setBillingItems((prev) => prev.map((b) => (b.id === id ? json.item : b)));
    }
  }

  async function saveScan() {
    if (!scanFile) {
      setScanMsg("Choose a scan file (Epson Connect PDF/image or local file).");
      return;
    }
    setScanBusy(true);
    setScanMsg(null);
    try {
      const contentBase64 = await fileToBase64(scanFile);
      const fileName =
        scanFileName.trim() ||
        scanFile.name ||
        `scan-${new Date().toISOString().slice(0, 10)}.pdf`;
      const res = await fetch("/api/finance/scans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save",
          fileName,
          comments: scanComments || undefined,
          contentBase64,
          contentType: scanFile.type || "application/pdf",
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Save failed");
      setScans((prev) => [json.scan, ...prev]);
      setScanMsg("Scan saved.");
      setScanFile(null);
      setScanFileName("");
      setScanComments("");
    } catch (err) {
      setScanMsg((err as Error).message);
    } finally {
      setScanBusy(false);
    }
  }

  async function sendScanEmail() {
    if (!emailScanId) return;
    setScanBusy(true);
    setScanMsg(null);
    try {
      const res = await fetch("/api/finance/scans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "email",
          scanId: emailScanId,
          to: emailTo,
          subject: emailSubject,
          body: emailBody,
          password: encryptOn && emailPassword ? emailPassword : undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Email failed");
      setScanMsg(
        json.encrypted
          ? "Email sent with encrypted attachment (password in body)."
          : "Email sent with PDF attachment."
      );
      setEmailScanId(null);
      setEncryptOn(false);
      setEmailPassword("");
    } catch (err) {
      setScanMsg((err as Error).message);
    } finally {
      setScanBusy(false);
    }
  }

  const listSum = rows.reduce((s, p) => s + p.amount, 0);

  return (
    <div className="app-shell">
      <AppHeader active="finance" userLabel={userLabel} showPrintQueue showRoadmap showSettings />
      <main className="app-main finance-page">
        <header className="finance-page-header">
          <div>
            <div className="page-title">
              <span aria-hidden>💰</span> Financial
            </div>
            <div className="page-subtitle">
              Facility-wide payments · two-way Zoho Books · payment structure workspace · facility
              scans
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
              <Link href="/roadmap" className="finance-zoho-hint" title="Configure after 24h in Vercel">
                Zoho Books not configured · Roadmap →
              </Link>
            )}
            {zoho.configured && (
              <>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ fontSize: 13 }}
                  disabled={syncing}
                  onClick={() => void syncAllUnsynced()}
                >
                  {syncing ? "Working…" : "Push paid → Books"}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ fontSize: 13 }}
                  disabled={syncing}
                  onClick={() => void pullAll()}
                >
                  {syncing ? "Working…" : "Refresh from Zoho"}
                </button>
              </>
            )}
            <Link href="/dashboard#finance" className="btn btn-secondary" style={{ fontSize: 13 }}>
              ← Dashboard
            </Link>
          </div>
        </header>

        {syncMsg && <p className="finance-sync-msg">{syncMsg}</p>}

        <div className="finance-zoho-bar">
          <span className={`finance-zoho-pill${zoho.configured ? " on" : ""}`}>
            {zoho.configured ? "● Zoho Books two-way" : "○ Zoho Books not linked"}
          </span>
          <span className="finance-zoho-meta">
            Push on pay / Sync · Pull invoice status · paid in Books auto-marks PostNow PAID.
            Exceptions appear under the ⚙ next to your name.
            {zoho.organizationId ? ` Org ${zoho.organizationId}` : " · Set ZOHO_BOOKS_* in Vercel (Roadmap)."}
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

        {/* ── Payment structure workspace ── */}
        <section id="payment-structure" className="finance-workspace-card">
          <div className="finance-workspace-head">
            <div>
              <h2 className="finance-ledger-title">Payment structure</h2>
              <p className="finance-ledger-sub">
                Draft rates and billing lines here. They will feed individual ledger entries and
                ultimately Zoho Books line items. Wire-up to dispatch fees is ongoing — use this as
                your working set.
              </p>
            </div>
          </div>
          <div className="finance-structure-form">
            <div className="field">
              <label htmlFor="bi-code">Code</label>
              <input id="bi-code" value={biCode} onChange={(e) => setBiCode(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="bi-name">Name</label>
              <input id="bi-name" value={biName} onChange={(e) => setBiName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="bi-amount">Amount (ZAR)</label>
              <input
                id="bi-amount"
                type="number"
                min={0}
                step="0.01"
                value={biAmount}
                onChange={(e) => setBiAmount(e.target.value)}
              />
            </div>
            <div className="field" style={{ flex: "1 1 200px" }}>
              <label htmlFor="bi-notes">Notes</label>
              <input
                id="bi-notes"
                value={biNotes}
                onChange={(e) => setBiNotes(e.target.value)}
                placeholder="Optional"
              />
            </div>
            <button
              type="button"
              className="btn btn-primary"
              style={{ fontSize: 13, alignSelf: "flex-end" }}
              disabled={biBusy}
              onClick={() => void addBillingItem()}
            >
              {biBusy ? "Saving…" : "Add billing line"}
            </button>
          </div>
          {biMsg && <p className="finance-sync-msg">{biMsg}</p>}
          {billingItems.length === 0 ? (
            <div className="finance-empty">No billing lines yet — add DISPATCH / print / courier rates.</div>
          ) : (
            <div className="finance-table-scroll">
              <table className="finance-table finance-table-page">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Name</th>
                    <th className="num">Amount</th>
                    <th>Zoho item</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {billingItems.map((b) => (
                    <tr key={b.id} style={{ opacity: b.active ? 1 : 0.55 }}>
                      <td>
                        <code>{b.code}</code>
                      </td>
                      <td>
                        {b.name}
                        {b.notes ? (
                          <div className="finance-muted" style={{ fontSize: 12 }}>
                            {b.notes}
                          </div>
                        ) : null}
                      </td>
                      <td className="num">{formatZar(b.amount)}</td>
                      <td className="finance-muted">{b.zohoItemId || "—"}</td>
                      <td>{b.active ? "Active" : "Inactive"}</td>
                      <td>
                        <button
                          type="button"
                          className="finance-action-link"
                          style={{
                            background: "none",
                            border: "none",
                            padding: 0,
                            cursor: "pointer",
                            font: "inherit",
                          }}
                          onClick={() => void toggleBillingActive(b.id, b.active)}
                        >
                          {b.active ? "Deactivate" : "Activate"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── Facility scans (Epson Connect) ── */}
        <section id="facility-scans" className="finance-workspace-card">
          <div className="finance-workspace-head">
            <div>
              <h2 className="finance-ledger-title">Facility scans · Epson Connect</h2>
              <p className="finance-ledger-sub">
                Save a scan (from Epson Connect or a local file), choose the file name, add comments,
                email as PDF, and optionally encrypt the attachment (password included in the email).
              </p>
            </div>
          </div>

          <div className="finance-scan-form">
            <div className="field">
              <label htmlFor="scan-file">Scan file</label>
              <input
                id="scan-file"
                type="file"
                accept="application/pdf,image/*"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setScanFile(f);
                  if (f && !scanFileName) setScanFileName(f.name);
                }}
              />
            </div>
            <div className="field">
              <label htmlFor="scan-name">File name</label>
              <input
                id="scan-name"
                value={scanFileName}
                onChange={(e) => setScanFileName(e.target.value)}
                placeholder="signed-return-CMRR….pdf"
              />
            </div>
            <div className="field" style={{ flex: "1 1 100%" }}>
              <label htmlFor="scan-comments">Comments</label>
              <textarea
                id="scan-comments"
                rows={2}
                value={scanComments}
                onChange={(e) => setScanComments(e.target.value)}
                placeholder="e.g. Wet-ink return POD · batch morning"
              />
            </div>
            <button
              type="button"
              className="btn btn-primary"
              style={{ fontSize: 13 }}
              disabled={scanBusy}
              onClick={() => void saveScan()}
            >
              {scanBusy ? "Saving…" : "Save scan"}
            </button>
          </div>
          {scanMsg && <p className="finance-sync-msg">{scanMsg}</p>}

          {emailScanId && (
            <div className="finance-scan-email-box">
              <div className="finance-workspace-head">
                <strong>Email scan</strong>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ fontSize: 12, padding: "6px 12px" }}
                  onClick={() => setEmailScanId(null)}
                >
                  Cancel
                </button>
              </div>
              <div className="finance-structure-form">
                <div className="field" style={{ flex: "1 1 220px" }}>
                  <label htmlFor="scan-email-to">Recipient</label>
                  <input
                    id="scan-email-to"
                    type="email"
                    value={emailTo}
                    onChange={(e) => setEmailTo(e.target.value)}
                    placeholder="client@example.com"
                  />
                </div>
                <div className="field" style={{ flex: "1 1 220px" }}>
                  <label htmlFor="scan-email-subject">Subject</label>
                  <input
                    id="scan-email-subject"
                    value={emailSubject}
                    onChange={(e) => setEmailSubject(e.target.value)}
                  />
                </div>
                <div className="field" style={{ flex: "1 1 100%" }}>
                  <label htmlFor="scan-email-body">Body</label>
                  <textarea
                    id="scan-email-body"
                    rows={3}
                    value={emailBody}
                    onChange={(e) => setEmailBody(e.target.value)}
                  />
                </div>
                <div className="field" style={{ flex: "1 1 100%" }}>
                  <label className="finance-check-label">
                    <input
                      type="checkbox"
                      checked={encryptOn}
                      onChange={(e) => setEncryptOn(e.target.checked)}
                    />{" "}
                    Encrypt attachment (AES) — add password to the email
                  </label>
                </div>
                {encryptOn && (
                  <div className="field">
                    <label htmlFor="scan-email-pass">Password</label>
                    <input
                      id="scan-email-pass"
                      type="text"
                      value={emailPassword}
                      onChange={(e) => setEmailPassword(e.target.value)}
                      placeholder="Share with recipient out-of-band if preferred"
                      autoComplete="off"
                    />
                  </div>
                )}
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ fontSize: 13 }}
                  disabled={scanBusy || !emailTo.trim() || (encryptOn && !emailPassword.trim())}
                  onClick={() => void sendScanEmail()}
                >
                  {scanBusy ? "Sending…" : "Send email with PDF"}
                </button>
              </div>
            </div>
          )}

          {scans.length === 0 ? (
            <div className="finance-empty">No scans saved yet.</div>
          ) : (
            <div className="finance-table-scroll">
              <table className="finance-table finance-table-page">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>File name</th>
                    <th>Size</th>
                    <th>Comments</th>
                    <th>By</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {scans.map((s) => (
                    <tr key={s.id}>
                      <td>{timeAgo(s.createdAt)}</td>
                      <td>
                        <strong>{s.fileName}</strong>
                      </td>
                      <td className="finance-muted">
                        {(s.sizeBytes / 1024).toFixed(0)} KB
                      </td>
                      <td className="finance-muted">{s.comments || "—"}</td>
                      <td className="finance-muted">{s.createdBy || "—"}</td>
                      <td>
                        <button
                          type="button"
                          className="finance-action-link"
                          style={{
                            background: "none",
                            border: "none",
                            padding: 0,
                            cursor: "pointer",
                            font: "inherit",
                          }}
                          onClick={() => {
                            setEmailScanId(s.id);
                            setEmailSubject(`PostNow scan — ${s.fileName}`);
                          }}
                        >
                          Email PDF
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="finance-ledger" aria-labelledby="ledger-heading">
          <div className="finance-ledger-head">
            <div>
              <h2 id="ledger-heading" className="finance-ledger-title">
                Payment ledger
              </h2>
              <p className="finance-ledger-sub">
                {rows.length} shown
                {statusFilter !== "ALL"
                  ? ` · filter: ${paymentStatusLabel(statusFilter as PaymentStatus)}`
                  : ""}
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
                    <th>Billing line</th>
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
                      <td className="finance-muted">
                        {p.billingItemCode ? (
                          <span title={p.billingItemName ?? ""}>
                            {p.billingItemCode}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
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
                        <div className="finance-zoho-cell">
                          {p.zohoBooksInvoiceId ? (
                            <a
                              href={zohoBooksAppUrl(p.zohoBooksInvoiceId)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="finance-action-link"
                              title={
                                p.zohoBooksLastPullAt
                                  ? `Last pull ${p.zohoBooksLastPullAt}`
                                  : p.zohoBooksSyncedAt
                                    ? `Synced ${p.zohoBooksSyncedAt}`
                                    : "Open invoice"
                              }
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
                          {p.zohoBooksInvoiceStatus && (
                            <span
                              className={`finance-zoho-status st-${p.zohoBooksInvoiceStatus}`}
                              title={
                                p.zohoBooksBalance != null
                                  ? `Balance R ${p.zohoBooksBalance.toFixed(2)}`
                                  : undefined
                              }
                            >
                              {p.zohoBooksInvoiceStatus}
                            </span>
                          )}
                        </div>
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
                            <>
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
                                Push
                              </button>
                              {p.zohoBooksInvoiceId && (
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
                                  onClick={() => void pullOne(p.id)}
                                >
                                  Pull
                                </button>
                              )}
                            </>
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
          PayFast ITN updates payment status and pushes to Zoho when configured. Pull from Books
          auto-marks PAID when the invoice is fully paid there. Exceptions log under ⚙. Payment
          structure lines are a staff workspace until dispatch auto-links go live.
        </p>
      </main>
    </div>
  );
}
