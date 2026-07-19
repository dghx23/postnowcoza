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
  Modal,
} from "@/components/ui";
import { FACILITY_ADDRESS } from "@/lib/facility";
import { buildPrintFeedback, type PrintFeedbackDetail } from "@/lib/printFeedback";
import {
  resolveJobPrintSettings,
  labelColorMode,
  labelPaperSize,
  labelPaperType,
  labelQuality,
  labelDoubleSided,
  PAPER_SIZES,
  PAPER_TYPES,
  PRINT_QUALITIES,
  PAPER_SOURCES,
  DOUBLE_SIDED,
  normalizeColorMode,
  normalizeCopies,
  type JobPrintSettings,
  type PrintColorMode,
} from "@/lib/printJobSettings";
import { getPrintSettings } from "@/lib/printSettings";

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
  printColorMode: string;
  printCopies: number;
}

interface FacilityPrintDefaults {
  printPaperSize: string;
  printPaperType: string;
  printQuality: string;
  printPaperSource: string;
  printBorderless: boolean;
  printDoubleSided: string;
}

interface HistoryRow {
  id: string;
  documentId: string;
  recipientName: string;
  city: string;
  documentStatus: string;
  updatedAt: string;
  feedback: PrintFeedbackDetail;
  via: string | null;
  jobId: string;
  customerColorMode: string | null;
  customerCopies: number | null;
  printedColorMode: string | null;
  printedCopies: number | null;
  confirmedAt: string | null;
  summary: string;
}

interface PrintQueueProps {
  userLabel: string;
  facilityLabel: string;
  documents: QueueDocument[];
  history: HistoryRow[];
  facilityDefaults: FacilityPrintDefaults;
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

  const [documents, facilityDefaults] = await Promise.all([
    prisma.document.findMany({
      where: { status: { in: ["UPLOADED", "QUEUED_FOR_PRINT"] } },
      orderBy: { createdAt: "asc" },
    }),
    getPrintSettings(),
  ]);

  const printJobs = await prisma.epsonPrintJob.findMany({
    orderBy: { updatedAt: "desc" },
    take: 50,
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
            in: [
              "epson_print_confirmed",
              "epson_print_failed",
              "email_print_failed",
              "epson_print_attention",
              "print_job_submitted",
            ],
          },
        },
        orderBy: { createdAt: "desc" },
      })
    : [];

  // Prefer audit that references this jobId; else latest outcome audit for the document.
  function auditForJob(documentId: string, jobId: string) {
    const forJob = printAudits.find((a) => {
      if (a.documentId !== documentId) return false;
      const meta = a.metadata as { jobId?: string } | null;
      return meta?.jobId === jobId;
    });
    if (forJob) return forJob;
    return printAudits.find(
      (a) =>
        a.documentId === documentId &&
        ["epson_print_confirmed", "epson_print_failed", "email_print_failed"].includes(a.action)
    );
  }

  const { buildPrintJobSummary } = await import("@/lib/printJobLog");

  const history: HistoryRow[] = [];
  for (const job of printJobs) {
    const audit = auditForJob(job.documentId, job.jobId);
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

    // Enrich via from job row when audit lacks it
    if (!feedback.via && job.via) {
      feedback.via = job.via;
      if (job.via === "epson_connect") feedback.source = "epson_connect";
      if (job.via === "epson_direct") feedback.source = "epson_direct";
    }

    const customer =
      job.customerColorMode != null
        ? { colorMode: job.customerColorMode, copies: job.customerCopies ?? 1 }
        : null;
    const printed =
      job.printedColorMode != null
        ? {
            colorMode: job.printedColorMode as "mono" | "color",
            copies: job.printedCopies ?? 1,
          }
        : null;

    history.push({
      id: job.id,
      documentId: job.documentId,
      recipientName: job.document.recipientName,
      city: job.document.city,
      documentStatus: job.document.status,
      updatedAt: job.updatedAt.toISOString(),
      feedback,
      via: job.via,
      jobId: job.jobId,
      customerColorMode: job.customerColorMode,
      customerCopies: job.customerCopies,
      printedColorMode: job.printedColorMode,
      printedCopies: job.printedCopies,
      confirmedAt: job.confirmedAt?.toISOString() ?? null,
      summary: buildPrintJobSummary({
        via: job.via,
        customer,
        printed,
        status: job.status,
      }),
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
        printColorMode: d.printColorMode,
        printCopies: d.printCopies,
      })),
      history,
      facilityDefaults: {
        printPaperSize: facilityDefaults.printPaperSize,
        printPaperType: facilityDefaults.printPaperType,
        printQuality: facilityDefaults.printQuality,
        printPaperSource: facilityDefaults.printPaperSource,
        printBorderless: facilityDefaults.printBorderless,
        printDoubleSided: facilityDefaults.printDoubleSided,
      },
    },
  };
};

export default function PrintQueue({
  userLabel,
  facilityLabel,
  documents: initialDocuments,
  history: initialHistory,
  facilityDefaults,
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
  const [toast, setToast] = useState<string | null>(null);
  const [printDialog, setPrintDialog] = useState<{
    doc: QueueDocument;
    via: "EPSON" | "EPSON_DIRECT";
  } | null>(null);
  const [jobSettings, setJobSettings] = useState<JobPrintSettings | null>(null);
  const [printDialogError, setPrintDialogError] = useState<string | null>(null);
  const [markModal, setMarkModal] = useState<{
    id: string;
    recipientName: string;
  } | null>(null);
  const [markComment, setMarkComment] = useState("");
  const [markConfirmed, setMarkConfirmed] = useState(false);
  const [markSubmitting, setMarkSubmitting] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/print-settings")
      .then((res) => res.json())
      .then((data) => setPrintProvider(data.provider ?? "EPSON"))
      .catch(() => setPrintProvider("EPSON"));
  }, []);

  function showToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(null), 4200);
  }

  async function refreshPrintHistory() {
    setHistorySyncing(true);
    setHistoryMsg(null);
    try {
      // Cross-match: Connect job status API + Zoho mailbox for Email Print
      const res = await fetch("/api/epson/jobs/reconcile", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Reconcile failed");
      const parts = [
        `Connect: polled ${json.connectPolled ?? 0}, updated ${json.connectUpdated ?? 0}`,
        `Mailbox: ${json.mailboxFetched ?? 0} msg, ${json.mailboxApplied ?? 0} applied`,
      ];
      if (Array.isArray(json.errors) && json.errors.length) {
        parts.push(`Notes: ${json.errors.slice(0, 2).join("; ")}`);
      }
      setHistoryMsg(`${parts.join(" · ")}. Reloading…`);
      router.replace(router.asPath);
    } catch (err) {
      setHistoryMsg((err as Error).message);
    } finally {
      setHistorySyncing(false);
    }
  }

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

  function openPrintDialog(doc: QueueDocument, via: "EPSON" | "EPSON_DIRECT") {
    const resolved = resolveJobPrintSettings({
      facility: facilityDefaults,
      customer: {
        printColorMode: doc.printColorMode,
        printCopies: doc.printCopies,
      },
    });
    setJobSettings(resolved);
    setPrintDialog({ doc, via });
    setPrintDialogError(null);
  }

  function closePrintDialog() {
    if (busyId) return;
    setPrintDialog(null);
    setJobSettings(null);
    setPrintDialogError(null);
  }

  async function confirmPrint() {
    if (!printDialog || !jobSettings) return;
    const { doc, via } = printDialog;
    setBusyId(doc.id);
    setErrorId(null);
    setPrintDialogError(null);
    try {
      const res = await fetch(`/api/documents/${doc.id}/print`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ via, settings: jobSettings }),
      });
      const data = await res.json();

      if (res.status === 401 && data.auth_url) {
        window.location.href = data.auth_url;
        return;
      }
      if (!res.ok) throw new Error(data.error ?? "Print failed");

      setDocuments((prev) => prev.filter((d) => d.id !== doc.id));
      setPrintDialog(null);
      setJobSettings(null);
      showToast(
        via === "EPSON_DIRECT"
          ? "Print EpsonMail sent — awaiting printer confirmation"
          : "Print EpsonAPI sent via Epson Connect",
      );
    } catch (err) {
      setPrintDialogError((err as Error).message);
      setErrorId({ id: doc.id, message: (err as Error).message });
    } finally {
      setBusyId(null);
    }
  }

  async function handleDownload(id: string) {
    setErrorId(null);
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

  function openMarkPrinted(doc: { id: string; recipientName: string }) {
    setMarkModal({ id: doc.id, recipientName: doc.recipientName });
    setMarkComment("");
    setMarkConfirmed(false);
    setMarkError(null);
  }

  function closeMarkPrinted() {
    if (markSubmitting) return;
    setMarkModal(null);
    setMarkComment("");
    setMarkConfirmed(false);
    setMarkError(null);
  }

  async function submitMarkPrinted() {
    if (!markModal) return;
    if (!markConfirmed) {
      setMarkError("Tick the confirmation box before submitting.");
      return;
    }
    setMarkSubmitting(true);
    setMarkError(null);
    setBusyId(markModal.id);
    setErrorId(null);
    try {
      const res = await fetch(`/api/documents/${markModal.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "PRINTED",
          confirmed: true,
          comment: markComment.trim(),
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to update status");
      const id = markModal.id;
      setDocuments((prev) => prev.filter((d) => d.id !== id));
      setMarkModal(null);
      setMarkComment("");
      setMarkConfirmed(false);
      showToast("Marked as printed");
    } catch (err) {
      setMarkError((err as Error).message);
      setErrorId({ id: markModal.id, message: (err as Error).message });
    } finally {
      setMarkSubmitting(false);
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
                🖨️ EpsonAPI · 📧 EpsonMail
                {printProvider ? ` · hub default: ${printProvider === "EPSON_DIRECT" ? "Mail" : "API"}` : ""}
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
                  <tr key={doc.id}>
                    <td>
                      <Link href={`/tracking/${doc.id}`} className="pq-doc-id">
                        #{doc.id.slice(0, 8).toUpperCase()}
                      </Link>
                    </td>
                    <td>
                      <div className="pq-recipient">{doc.recipientName}</div>
                      <div className="pq-city">{doc.city}</div>
                      <div className="pq-print-pref">
                        {labelColorMode(normalizeColorMode(doc.printColorMode))} · {doc.printCopies}{" "}
                        {doc.printCopies === 1 ? "copy" : "copies"}
                      </div>
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
                    <td>
                      <div className="pq-actions">
                        <button type="button" className="pq-btn pq-btn-download" onClick={() => void handleDownload(doc.id)}>
                          📄 Download
                        </button>
                        <button
                          type="button"
                          className="pq-btn pq-btn-print"
                          disabled={busyId === doc.id}
                          title="Print via Epson Connect cloud API"
                          onClick={() => openPrintDialog(doc, "EPSON")}
                        >
                          {busyId === doc.id ? "Sending…" : "Print EpsonAPI"}
                          {busyId !== doc.id && <span className="sparkle">✦</span>}
                        </button>
                        <button
                          type="button"
                          className="pq-btn pq-btn-print-mail"
                          disabled={busyId === doc.id}
                          title="Email PDF to the printer (Epson Direct)"
                          onClick={() => openPrintDialog(doc, "EPSON_DIRECT")}
                        >
                          {busyId === doc.id ? "Sending…" : "Print EpsonMail"}
                        </button>
                        <button
                          type="button"
                          className="pq-btn pq-btn-mark"
                          disabled={busyId === doc.id}
                          onClick={() => openMarkPrinted(doc)}
                        >
                          Mark Printed
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

        {/* ═══ HISTORY — platform submission ↔ printer feedback ═══ */}
        <div className="pq-history">
          <div className="pq-history-head">
            <h3>📋 Print history</h3>
            <button
              type="button"
              className="pq-btn pq-btn-download"
              disabled={historySyncing}
              onClick={() => void refreshPrintHistory()}
              title="Poll Epson Connect job status + pull Email Print notifications from Zoho"
            >
              {historySyncing ? "Matching feedback…" : "↻ Match printer feedback"}
            </button>
          </div>
          <p className="pq-history-note">
            Each row is a <strong>platform print submission</strong> cross-matched with{" "}
            <strong>printer feedback</strong> (Connect API / webhook for EpsonAPI, owner email for
            EpsonMail). Request IDs open tracking.
          </p>
          {historyMsg && <div className="pq-history-msg">{historyMsg}</div>}
          {history.length === 0 ? (
            <div className="pq-empty">No print jobs recorded yet. Submit a print from the queue above.</div>
          ) : (
            <table className="pq-table pq-history-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Request</th>
                  <th>Channel</th>
                  <th>Customer → Printed</th>
                  <th>Doc</th>
                  <th>Match</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {history.map((row) => {
                  const viaLabel =
                    row.via === "epson_connect"
                      ? "EpsonAPI"
                      : row.via === "epson_direct"
                        ? "EpsonMail"
                        : row.via === "manual_mark"
                          ? "Manual"
                          : row.feedback.source === "epson_connect"
                            ? "EpsonAPI"
                            : "Print";
                  const cust =
                    row.customerColorMode != null
                      ? `${row.customerColorMode === "color" ? "Colour" : "B&W"} ×${row.customerCopies ?? 1}`
                      : "—";
                  const printed =
                    row.printedColorMode != null
                      ? `${row.printedColorMode === "color" ? "Colour" : "B&W"} ×${row.printedCopies ?? 1}`
                      : "—";
                  const matchClass =
                    row.feedback.matchState === "matched_ok"
                      ? "ok"
                      : row.feedback.matchState === "matched_fail"
                        ? "fail"
                        : row.feedback.matchState === "awaiting"
                          ? "await"
                          : "";
                  return (
                    <tr key={row.id}>
                      <td title={new Date(row.updatedAt).toISOString()}>{timeAgo(row.updatedAt)}</td>
                      <td>
                        <Link href={`/tracking/${row.documentId}`} className="pq-doc-id">
                          #{row.documentId.slice(0, 10).toUpperCase()}
                        </Link>
                        <div className="pq-job-id" title={row.jobId}>
                          job {row.jobId.slice(0, 14)}
                          {row.jobId.length > 14 ? "…" : ""}
                        </div>
                      </td>
                      <td>
                        <span className="pq-channel">{viaLabel}</span>
                      </td>
                      <td>
                        <div className="pq-cross">
                          <span className="pq-cross-cust" title="Customer selected">
                            {cust}
                          </span>
                          <span className="pq-cross-arrow" aria-hidden>
                            →
                          </span>
                          <span className="pq-cross-print" title="Sent to printer">
                            {printed}
                          </span>
                        </div>
                      </td>
                      <td>
                        <StatusPill status={row.documentStatus} />
                      </td>
                      <td>
                        <span className={`pq-match ${matchClass}`} title={row.feedback.matchLabel}>
                          {row.feedback.matchLabel ?? row.feedback.label}
                        </span>
                      </td>
                      <td>
                        <PrintFeedbackChip feedback={row.feedback} size="sm" />
                        {row.confirmedAt && (
                          <div className="pq-confirmed-at">
                            Confirmed {timeAgo(row.confirmedAt)}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
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

        {printDialog && jobSettings && (
          <Modal
            title={printDialog.via === "EPSON" ? "Confirm Print EpsonAPI" : "Confirm Print EpsonMail"}
            onClose={closePrintDialog}
          >
            <p className="pq-mark-intro">
              Customer selected print options for{" "}
              <strong>{printDialog.doc.recipientName}</strong> (
              <span className="pq-doc-id">#{printDialog.doc.id.slice(0, 8).toUpperCase()}</span>).
              Review what the printer will do, then confirm.
            </p>

            <div className="print-confirm-grid">
              <div className="print-confirm-card customer">
                <div className="print-confirm-card-title">Customer selected</div>
                <dl className="print-confirm-dl">
                  <div>
                    <dt>Colour</dt>
                    <dd>{labelColorMode(normalizeColorMode(printDialog.doc.printColorMode))}</dd>
                  </div>
                  <div>
                    <dt>Copies</dt>
                    <dd>{printDialog.doc.printCopies}</dd>
                  </div>
                </dl>
              </div>
              <div className="print-confirm-card printer">
                <div className="print-confirm-card-title">Printer will use</div>
                <dl className="print-confirm-dl">
                  <div>
                    <dt>Colour</dt>
                    <dd>{labelColorMode(jobSettings.colorMode)}</dd>
                  </div>
                  <div>
                    <dt>Copies</dt>
                    <dd>{jobSettings.copies}</dd>
                  </div>
                  <div>
                    <dt>Paper</dt>
                    <dd>
                      {labelPaperSize(jobSettings.paperSize)} · {labelPaperType(jobSettings.paperType)}
                    </dd>
                  </div>
                  <div>
                    <dt>Quality</dt>
                    <dd>{labelQuality(jobSettings.printQuality)}</dd>
                  </div>
                  <div>
                    <dt>Sides</dt>
                    <dd>{labelDoubleSided(jobSettings.doubleSided)}</dd>
                  </div>
                  <div>
                    <dt>Borderless</dt>
                    <dd>{jobSettings.borderless ? "Yes" : "No"}</dd>
                  </div>
                </dl>
                {printDialog.via === "EPSON_DIRECT" && (
                  <p className="print-confirm-note">
                    EpsonMail cannot set colour/copies via API — preferences are noted in the email
                    subject for the operator.
                  </p>
                )}
              </div>
            </div>

            <div className="print-confirm-adjust">
              <div className="print-confirm-card-title">Adjust for this job (optional)</div>
              <div className="print-confirm-fields">
                <div className="field">
                  <label>Colour</label>
                  <select
                    value={jobSettings.colorMode}
                    onChange={(e) =>
                      setJobSettings({
                        ...jobSettings,
                        colorMode: e.target.value as PrintColorMode,
                      })
                    }
                    disabled={busyId === printDialog.doc.id}
                  >
                    <option value="mono">Black &amp; white</option>
                    <option value="color">Colour</option>
                  </select>
                </div>
                <div className="field">
                  <label>Copies</label>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={jobSettings.copies}
                    onChange={(e) =>
                      setJobSettings({
                        ...jobSettings,
                        copies: normalizeCopies(e.target.value),
                      })
                    }
                    disabled={busyId === printDialog.doc.id}
                  />
                </div>
                <div className="field">
                  <label>Paper size</label>
                  <select
                    value={jobSettings.paperSize}
                    onChange={(e) => setJobSettings({ ...jobSettings, paperSize: e.target.value })}
                    disabled={busyId === printDialog.doc.id}
                  >
                    {PAPER_SIZES.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Paper type</label>
                  <select
                    value={jobSettings.paperType}
                    onChange={(e) => setJobSettings({ ...jobSettings, paperType: e.target.value })}
                    disabled={busyId === printDialog.doc.id}
                  >
                    {PAPER_TYPES.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Quality</label>
                  <select
                    value={jobSettings.printQuality}
                    onChange={(e) => setJobSettings({ ...jobSettings, printQuality: e.target.value })}
                    disabled={busyId === printDialog.doc.id}
                  >
                    {PRINT_QUALITIES.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Paper source</label>
                  <select
                    value={jobSettings.paperSource}
                    onChange={(e) => setJobSettings({ ...jobSettings, paperSource: e.target.value })}
                    disabled={busyId === printDialog.doc.id}
                  >
                    {PAPER_SOURCES.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Double-sided</label>
                  <select
                    value={jobSettings.doubleSided}
                    onChange={(e) => setJobSettings({ ...jobSettings, doubleSided: e.target.value })}
                    disabled={busyId === printDialog.doc.id}
                  >
                    {DOUBLE_SIDED.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
                <label className="checkbox-row print-confirm-borderless">
                  <input
                    type="checkbox"
                    checked={jobSettings.borderless}
                    onChange={(e) => setJobSettings({ ...jobSettings, borderless: e.target.checked })}
                    disabled={busyId === printDialog.doc.id}
                  />
                  Borderless
                </label>
              </div>
            </div>

            {printDialogError && <div className="form-error" style={{ marginTop: 12 }}>{printDialogError}</div>}
            <div className="pq-mark-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={closePrintDialog}
                disabled={busyId === printDialog.doc.id}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busyId === printDialog.doc.id}
                onClick={() => void confirmPrint()}
              >
                {busyId === printDialog.doc.id
                  ? "Sending…"
                  : printDialog.via === "EPSON"
                    ? "Print with these settings"
                    : "Send EpsonMail"}
              </button>
            </div>
          </Modal>
        )}

        {markModal && (
          <Modal title="Mark as printed" onClose={closeMarkPrinted}>
            <p className="pq-mark-intro">
              Confirm that{" "}
              <strong>{markModal.recipientName}</strong> (
              <span className="pq-doc-id">#{markModal.id.slice(0, 8).toUpperCase()}</span>) was
              printed successfully. This advances the document to <strong>PRINTED</strong> and may
              trigger next-day courier booking if payment is complete.
            </p>
            <div className="field" style={{ marginTop: 14 }}>
              <label htmlFor="mark-comment">Comments (optional)</label>
              <textarea
                id="mark-comment"
                rows={3}
                value={markComment}
                onChange={(e) => setMarkComment(e.target.value)}
                placeholder="e.g. Printed on L3251, 2 pages, slight jam cleared…"
                maxLength={2000}
                disabled={markSubmitting}
              />
            </div>
            <label className="pq-mark-confirm">
              <input
                type="checkbox"
                checked={markConfirmed}
                onChange={(e) => setMarkConfirmed(e.target.checked)}
                disabled={markSubmitting}
              />
              <span>I confirm this document was printed</span>
            </label>
            {markError && <div className="form-error" style={{ marginTop: 10 }}>{markError}</div>}
            <div className="pq-mark-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={closeMarkPrinted}
                disabled={markSubmitting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!markConfirmed || markSubmitting}
                onClick={() => void submitMarkPrinted()}
              >
                {markSubmitting ? "Submitting…" : "Submit"}
              </button>
            </div>
          </Modal>
        )}
      </main>
    </div>
  );
}
