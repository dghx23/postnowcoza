import { useEffect, useMemo, useState } from "react";
import type { GetServerSideProps } from "next";
import Link from "next/link";
import { useRouter } from "next/router";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/db";
import {
  AppHeader,
  StatusPill,
  Alert,
  PrinterStatus,
  PrintFeedbackChip,
} from "@/components/ui";
import { FACILITY_ADDRESS } from "@/lib/facility";
import { buildPrintFeedback, type PrintFeedbackDetail } from "@/lib/printFeedback";

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

interface QueueDocument {
  id: string;
  createdAt: string;
  recipientName: string;
  city: string;
  streetAddress: string;
  localArea: string;
  postalCode: string;
  zone: string;
  returnPreference: "DIRECT" | "MANAGED";
  status: string;
}

interface HistoryRow {
  id: string;
  documentId: string;
  recipientName: string;
  city: string;
  documentStatus: string;
  updatedAt: string;
  feedback: PrintFeedbackDetail;
}

interface PrintQueueProps {
  userLabel: string;
  facilityLabel: string;
  documents: QueueDocument[];
  history: HistoryRow[];
}

export const getServerSideProps: GetServerSideProps<PrintQueueProps> = async (context) => {
  const session = await getServerSession(context.req, context.res, authOptions);
  if (!session?.user?.email) {
    return { redirect: { destination: "/login", permanent: false } };
  }

  const user = await prisma.user.findUnique({ where: { email: session.user.email } });
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return { redirect: { destination: "/dashboard", permanent: false } };
  }

  const documents = await prisma.document.findMany({
    where: { status: { in: ["UPLOADED", "QUEUED_FOR_PRINT"] } },
    orderBy: { createdAt: "asc" },
  });

  const printJobs = await prisma.epsonPrintJob.findMany({
    orderBy: { updatedAt: "desc" },
    take: 40,
    include: {
      document: {
        select: {
          id: true,
          recipientName: true,
          city: true,
          status: true,
        },
      },
    },
  });

  const docIds = [...new Set(printJobs.map((j) => j.documentId))];
  const printAudits = docIds.length
    ? await prisma.auditEvent.findMany({
        where: {
          documentId: { in: docIds },
          action: {
            in: ["epson_print_confirmed", "epson_print_failed", "email_print_failed"],
          },
        },
        orderBy: { createdAt: "desc" },
      })
    : [];

  const latestAuditByDoc = new Map<string, (typeof printAudits)[0]>();
  for (const a of printAudits) {
    if (!latestAuditByDoc.has(a.documentId)) latestAuditByDoc.set(a.documentId, a);
  }

  const history: HistoryRow[] = [];
  for (const job of printJobs) {
    const audit = latestAuditByDoc.get(job.documentId);
    const feedback = buildPrintFeedback({
      jobStatus: job.status,
      jobId: job.jobId,
      jobUpdatedAt: job.updatedAt,
      auditAction: audit?.action,
      auditMetadata: audit?.metadata,
      auditAt: audit?.createdAt,
      documentStatus: job.document.status,
    });
    if (!feedback) continue;
    history.push({
      id: job.id,
      documentId: job.documentId,
      recipientName: job.document.recipientName,
      city: job.document.city,
      documentStatus: job.document.status,
      updatedAt: job.updatedAt.toISOString(),
      feedback,
    });
  }

  return {
    props: {
      userLabel: `${user.email} · Print Ops`,
      facilityLabel: [FACILITY_ADDRESS.street_address, FACILITY_ADDRESS.city].filter(Boolean).join(", "),
      documents: documents.map((d) => ({
        id: d.id,
        createdAt: d.createdAt.toISOString(),
        recipientName: d.recipientName,
        city: d.city,
        streetAddress: d.streetAddress,
        localArea: d.localArea,
        postalCode: d.postalCode,
        zone: d.zone,
        returnPreference: d.returnPreference,
        status: d.status,
      })),
      history,
    },
  };
};

export default function PrintQueue({
  userLabel,
  facilityLabel,
  documents: initialDocuments,
  history: initialHistory,
}: PrintQueueProps) {
  const router = useRouter();
  const [documents, setDocuments] = useState(initialDocuments);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<{ id: string; message: string } | null>(null);
  const [epsonBanner, setEpsonBanner] = useState<"connected" | "error" | null>(null);
  const [search, setSearch] = useState("");
  const [returnFilter, setReturnFilter] = useState<"ALL" | "DIRECT" | "MANAGED">("ALL");
  const [sortKey, setSortKey] = useState<"oldest" | "newest" | "recipient">("oldest");
  const [printProvider, setPrintProvider] = useState<"EPSON" | "EPSON_DIRECT" | null>(null);
  const history = initialHistory;
  const [historySyncing, setHistorySyncing] = useState(false);
  const [historyMsg, setHistoryMsg] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/print-settings")
      .then((res) => res.json())
      .then((data) => setPrintProvider(data.provider ?? "EPSON"))
      .catch(() => setPrintProvider("EPSON"));
  }, []);

  useEffect(() => {
    if (documents.length > 0 && !previewId) {
      setPreviewId(documents[0]!.id);
    }
  }, [documents, previewId]);

  function showToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(null), 4200);
  }

  async function refreshHistoryFromMailbox() {
    setHistorySyncing(true);
    setHistoryMsg(null);
    try {
      const res = await fetch("/api/epson/notifications/sync?includeSeen=1", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const diag =
          json.diag && typeof json.diag === "object"
            ? ` [userSet=${json.diag.userSet}, passSet=${json.diag.passwordSet}, passLen=${json.diag.passwordLength}, host=${json.diag.host}]`
            : "";
        throw new Error((json.error ?? "Mailbox sync failed") + diag);
      }
      setHistoryMsg(
        `Mailbox checked: ${json.fetched ?? 0} notification(s), ${json.applied ?? 0} applied. Reloading…`,
      );
      router.replace(router.asPath);
    } catch (err) {
      setHistoryMsg((err as Error).message);
    } finally {
      setHistorySyncing(false);
    }
  }

  const previewDoc = documents.find((d) => d.id === previewId) ?? documents[0] ?? null;

  const visibleDocuments = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = documents.filter((doc) => {
      if (returnFilter !== "ALL" && doc.returnPreference !== returnFilter) return false;
      if (!q) return true;
      return (
        doc.recipientName.toLowerCase().includes(q) ||
        doc.city.toLowerCase().includes(q) ||
        doc.id.toLowerCase().includes(q)
      );
    });
    rows = [...rows].sort((a, b) => {
      if (sortKey === "recipient") return a.recipientName.localeCompare(b.recipientName);
      const diff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return sortKey === "oldest" ? diff : -diff;
    });
    return rows;
  }, [documents, search, returnFilter, sortKey]);

  const directCount = documents.filter((d) => d.returnPreference === "DIRECT").length;
  const managedCount = documents.filter((d) => d.returnPreference === "MANAGED").length;
  const oldestWait = documents.length > 0 ? timeAgo(documents[0].createdAt) : "—";

  useEffect(() => {
    if (!router.isReady) return;
    const { epson } = router.query;
    if (epson === "connected" || epson === "error") {
      setEpsonBanner(epson);
      const { epson: _drop, ...rest } = router.query;
      router.replace({ pathname: router.pathname, query: rest }, undefined, { shallow: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady]);

  async function handlePrintApi(id: string) {
    setBusyId(id);
    setErrorId(null);
    setPreviewId(id);
    try {
      const res = await fetch(`/api/documents/${id}/print`, { method: "POST" });
      const data = await res.json();

      if (res.status === 401 && data.auth_url) {
        window.location.href = data.auth_url;
        return;
      }
      if (!res.ok) throw new Error(data.error ?? "Print failed");

      setDocuments((prev) => prev.filter((d) => d.id !== id));
      showToast(
        printProvider === "EPSON_DIRECT"
          ? "Email Print sent — awaiting printer confirmation"
          : "Instant print sent via Epson Connect",
      );
    } catch (err) {
      setErrorId({ id, message: (err as Error).message });
    } finally {
      setBusyId(null);
    }
  }

  async function handleDownload(id: string) {
    setErrorId(null);
    setPreviewId(id);
    try {
      const res = await fetch(`/api/documents/${id}/download`);
      if (!res.ok) throw new Error((await res.json()).error ?? "Download failed");
      const { url } = await res.json();
      window.open(url, "_blank", "noopener,noreferrer");
      showToast("Download ready");
    } catch (err) {
      setErrorId({ id, message: (err as Error).message });
    }
  }

  async function handleMarkPrinted(id: string) {
    setBusyId(id);
    setErrorId(null);
    setPreviewId(id);
    try {
      const res = await fetch(`/api/documents/${id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "PRINTED" }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to update status");
      setDocuments((prev) => prev.filter((d) => d.id !== id));
      showToast("Marked as printed");
    } catch (err) {
      setErrorId({ id, message: (err as Error).message });
    } finally {
      setBusyId(null);
    }
  }

  function statusClass(status: string) {
    if (status === "UPLOADED") return "uploaded";
    if (status === "QUEUED_FOR_PRINT") return "queued";
    if (status === "PRINTED") return "printed";
    return "uploaded";
  }

  return (
    <div className="app-shell">
      <AppHeader active="print-queue" userLabel={userLabel} showPrintQueue showRoadmap />
      <main className="app-main pq-hub">
        {/* ═══ HEADER ═══ */}
        <header className="pq-header">
          <div>
            <div className="pq-logo">
              Post<span>Now</span>
              <small>Instant Print Queue</small>
            </div>
            <div className="pq-header-meta">
              {facilityLabel && (
                <span className="pq-hub-location">
                  📍 <strong>{facilityLabel}</strong>
                </span>
              )}
              <span className="pq-staff-badge">👤 Staff · Print Ops</span>
              <span className="pq-epson-badge">
                {printProvider === "EPSON_DIRECT" ? "📧 Email Print" : "🖨️ Epson API"}
              </span>
              <span className="pq-count-pill">{documents.length} pending</span>
            </div>
          </div>
          <div className="pq-header-actions">
            <Link href="/printer" className="btn btn-secondary" style={{ fontSize: 13 }}>
              Printer Hub →
            </Link>
            <PrinterStatus />
          </div>
        </header>

        {epsonBanner === "connected" && (
          <Alert title="Epson Connect linked">Printer connection authorized — try printing again.</Alert>
        )}
        {epsonBanner === "error" && (
          <Alert title="Epson Connect authorization failed" tone="danger">
            Could not connect to Epson Connect. Try again, or check the printer account credentials.
          </Alert>
        )}

        {documents.length > 0 && (
          <div className="pq-stats">
            <div className="pq-stat">
              <div className="pq-stat-val">{documents.length}</div>
              <div className="pq-stat-label">Pending</div>
            </div>
            <div className="pq-stat">
              <div className="pq-stat-val">{directCount}</div>
              <div className="pq-stat-label">Direct return</div>
            </div>
            <div className="pq-stat">
              <div className="pq-stat-val">{managedCount}</div>
              <div className="pq-stat-label">Via PostNow</div>
            </div>
            <div className="pq-stat">
              <div className="pq-stat-val pq-stat-val-sm">{oldestWait}</div>
              <div className="pq-stat-label">Oldest waiting</div>
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="pq-filters">
          <input
            className="pq-search"
            placeholder="Search recipient, city, or request ID…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            value={returnFilter}
            onChange={(e) => setReturnFilter(e.target.value as "ALL" | "DIRECT" | "MANAGED")}
          >
            <option value="ALL">All return types</option>
            <option value="DIRECT">Direct only</option>
            <option value="MANAGED">Via PostNow only</option>
          </select>
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as "oldest" | "newest" | "recipient")}
          >
            <option value="oldest">Oldest first</option>
            <option value="newest">Newest first</option>
            <option value="recipient">Recipient A–Z</option>
          </select>
        </div>

        {/* ═══ QUEUE TABLE ═══ */}
        <div className="pq-table-wrap">
          {documents.length === 0 ? (
            <div className="pq-empty">Nothing in the print queue right now.</div>
          ) : visibleDocuments.length === 0 ? (
            <div className="pq-empty">No documents match your search or filter.</div>
          ) : (
            <table className="pq-table">
              <thead>
                <tr>
                  <th>Request ID</th>
                  <th>Recipient</th>
                  <th>Uploaded</th>
                  <th>Return</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleDocuments.map((doc) => (
                  <tr
                    key={doc.id}
                    className={previewId === doc.id ? "pq-row-active" : undefined}
                    onClick={() => setPreviewId(doc.id)}
                  >
                    <td>
                      <Link href={`/tracking/${doc.id}`} className="pq-doc-id" onClick={(e) => e.stopPropagation()}>
                        #{doc.id.slice(0, 8).toUpperCase()}
                      </Link>
                    </td>
                    <td>
                      <div className="pq-recipient">{doc.recipientName}</div>
                      <div className="pq-city">{doc.city}</div>
                    </td>
                    <td>{timeAgo(doc.createdAt)}</td>
                    <td>
                      <span
                        className={`pq-badge-return ${doc.returnPreference === "DIRECT" ? "direct" : "via"}`}
                      >
                        {doc.returnPreference === "MANAGED" ? "Via PostNow" : "Direct"}
                      </span>
                    </td>
                    <td>
                      <span className={`pq-badge-status ${statusClass(doc.status)}`}>
                        {doc.status === "QUEUED_FOR_PRINT" ? "QUEUED" : doc.status}
                      </span>
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="pq-actions">
                        <button type="button" className="pq-btn pq-btn-download" onClick={() => void handleDownload(doc.id)}>
                          📄 Download
                        </button>
                        <button
                          type="button"
                          className="pq-btn pq-btn-print"
                          disabled={busyId === doc.id}
                          onClick={() => void handlePrintApi(doc.id)}
                        >
                          {busyId === doc.id
                            ? "Sending…"
                            : printProvider === "EPSON_DIRECT"
                              ? "📧 Email Print"
                              : "Print Instant"}
                          {busyId !== doc.id && printProvider !== "EPSON_DIRECT" && (
                            <span className="sparkle">✦</span>
                          )}
                        </button>
                        <button
                          type="button"
                          className="pq-btn pq-btn-mark"
                          disabled={busyId === doc.id}
                          onClick={() => void handleMarkPrinted(doc.id)}
                        >
                          {busyId === doc.id ? "…" : "Mark Printed"}
                        </button>
                      </div>
                      {errorId?.id === doc.id && <div className="form-error" style={{ marginTop: 6 }}>{errorId.message}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* ═══ LABEL PREVIEW + FLOW ═══ */}
        <div className="pq-label-section">
          <h3>🖨️ What prints (document PDF → Epson)</h3>
          <div className="pq-label-mock">
            <div className="pq-label-head">
              <span className="pq-label-brand">
                Post<span>Now</span>
              </span>
              <span className="pq-label-badge">SECURE DISPATCH</span>
            </div>
            <div className="pq-label-tagline">Delivered reliably · POPIA chain of custody</div>
            <div className="pq-label-address">
              <div className="to-label">📬 DELIVER TO</div>
              <div className="name">{previewDoc?.recipientName ?? "—"}</div>
              <div className="addr">
                {previewDoc
                  ? [previewDoc.streetAddress, previewDoc.localArea, previewDoc.city, previewDoc.postalCode]
                      .filter(Boolean)
                      .join(", ")
                  : "Select a row in the queue"}
              </div>
            </div>
            <div className="pq-label-barcode">
              <span className="tracking">
                {previewDoc ? `PN-${previewDoc.id.slice(0, 7).toUpperCase()}` : "PN-———————"}
              </span>
              <div className="barcode-placeholder" />
            </div>
            <div className="pq-label-footer">
              <span>🔒 PostNow Secure Dispatch</span>
              <span className="mono">app.postnow.co.za/tracking</span>
            </div>
          </div>
          <div className="pq-flow-box">
            <h4>✅ Instant print flow</h4>
            <div className="pq-flow-step">
              <span className="num">1</span>
              <span>
                Staff clicks <span className="hl">Print Instant</span>
                {printProvider === "EPSON_DIRECT" ? " / Email Print" : ""}
              </span>
            </div>
            <div className="pq-flow-step">
              <span className="num">2</span>
              <span>PDF downloaded from secure storage (R2)</span>
            </div>
            <div className="pq-flow-step">
              <span className="num">3</span>
              <span>
                Sent via{" "}
                <span className="hl">
                  {printProvider === "EPSON_DIRECT" ? "Epson Email Print" : "Epson Connect API"}
                </span>
                <span className="pq-epson-tag">Cloud</span>
              </span>
            </div>
            <div className="pq-flow-step">
              <span className="num">4</span>
              <span>
                Status → <span className="hl">PRINTED</span>; confirmation email syncs to Print history
              </span>
            </div>
            <div className="pq-flow-step">
              <span className="num">5</span>
              <span>
                Open <Link href="/printer">Printer Hub</Link> for live queue &amp; today’s stats
              </span>
            </div>
          </div>
        </div>

        {/* ═══ HISTORY ═══ */}
        <div className="pq-history">
          <div className="pq-history-head">
            <h3>📋 Print history</h3>
            <button
              type="button"
              className="pq-btn pq-btn-download"
              disabled={historySyncing}
              onClick={() => void refreshHistoryFromMailbox()}
            >
              {historySyncing ? "Checking mailbox…" : "↻ Refresh from mailbox"}
            </button>
          </div>
          <p className="pq-history-note">
            Outcomes from Epson Connect and Email Print notifications. Request IDs open tracking.
          </p>
          {historyMsg && <div className="pq-history-msg">{historyMsg}</div>}
          {history.length === 0 ? (
            <div className="pq-empty">No print jobs recorded yet.</div>
          ) : (
            <table className="pq-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Request ID</th>
                  <th>Recipient</th>
                  <th>Doc status</th>
                  <th>Print outcome</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <tr key={row.id}>
                    <td title={new Date(row.updatedAt).toISOString()}>{timeAgo(row.updatedAt)}</td>
                    <td>
                      <Link href={`/tracking/${row.documentId}`} className="pq-doc-id">
                        #{row.documentId.slice(0, 10).toUpperCase()}
                      </Link>
                    </td>
                    <td>
                      <div className="pq-recipient">{row.recipientName}</div>
                      <div className="pq-city">{row.city}</div>
                    </td>
                    <td>
                      <StatusPill status={row.documentStatus} />
                    </td>
                    <td>
                      <PrintFeedbackChip feedback={row.feedback} size="sm" />
                    </td>
                    <td className="pq-detail-cell" title={row.feedback.summary}>
                      {row.feedback.subject ||
                        row.feedback.snippet?.slice(0, 80) ||
                        row.feedback.summary}
                      {(row.feedback.snippet?.length ?? 0) > 80 ? "…" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {toast && (
          <div className="pq-toast show" role="status">
            <span className="icon">✓</span>
            <span>{toast}</span>
            <button type="button" className="close-toast" onClick={() => setToast(null)} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
