import { useEffect, useMemo, useState } from "react";
import type { GetServerSideProps } from "next";
import Link from "next/link";
import { useRouter } from "next/router";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/db";
import {
  AppHeader,
  Card,
  Badge,
  StatusPill,
  Alert,
  PrinterStatus,
  DataTable,
  MetricTile,
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

  useEffect(() => {
    fetch("/api/print-settings")
      .then((res) => res.json())
      .then((data) => setPrintProvider(data.provider ?? "EPSON"))
      .catch(() => setPrintProvider("EPSON"));
  }, []);

  async function refreshHistoryFromMailbox() {
    setHistorySyncing(true);
    setHistoryMsg(null);
    try {
      const res = await fetch("/api/epson/notifications/sync", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Mailbox sync failed");
      setHistoryMsg(
        `Mailbox checked: ${json.fetched ?? 0} notification(s), ${json.applied ?? 0} applied. Reloading…`,
      );
      // Full reload so history SSR rows + queue re-queueing stay consistent.
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

  async function handlePrintApi(id: string) {
    setBusyId(id);
    setErrorId(null);
    try {
      const res = await fetch(`/api/documents/${id}/print`, { method: "POST" });
      const data = await res.json();

      if (res.status === 401 && data.auth_url) {
        window.location.href = data.auth_url;
        return;
      }
      if (!res.ok) throw new Error(data.error ?? "Print failed");

      setDocuments((prev) => prev.filter((d) => d.id !== id));
    } catch (err) {
      setErrorId({ id, message: (err as Error).message });
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
    } catch (err) {
      setErrorId({ id, message: (err as Error).message });
    }
  }

  async function handleMarkPrinted(id: string) {
    setBusyId(id);
    setErrorId(null);
    try {
      const res = await fetch(`/api/documents/${id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "PRINTED" }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to update status");
      setDocuments((prev) => prev.filter((d) => d.id !== id));
    } catch (err) {
      setErrorId({ id, message: (err as Error).message });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="app-shell">
      <AppHeader active="print-queue" userLabel={userLabel} showPrintQueue showRoadmap />
      <main className="app-main">
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div className="page-head">
            <div>
              <div className="page-title">Print Queue</div>
              <div className="page-subtitle">
                Documents awaiting secure intake and printing — {documents.length} pending.
              </div>
              {facilityLabel && (
                <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>
                  📍 {facilityLabel} · 👤 Staff · Print Ops
                </div>
              )}
            </div>
            <PrinterStatus />
          </div>

          {epsonBanner === "connected" && (
            <Alert title="Epson Connect linked">Printer connection authorized — try printing again.</Alert>
          )}
          {epsonBanner === "error" && (
            <Alert title="Epson Connect authorization failed" tone="danger">
              Could not connect to Epson Connect. Try again, or check the printer account credentials.
            </Alert>
          )}

          {documents.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
              <MetricTile label="Pending" value={String(documents.length)} tone="teal" />
              <MetricTile label="Direct return" value={String(directCount)} tone="navy" />
              <MetricTile label="Via PostNow" value={String(managedCount)} tone="gold" />
              <MetricTile label="Oldest waiting" value={oldestWait} tone="navy" />
            </div>
          )}

          {documents.length === 0 ? (
            <Card>
              <div style={{ fontSize: 14, color: "var(--text-secondary)" }}>
                Nothing in the print queue right now.
              </div>
            </Card>
          ) : (
            <Card>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 16 }}>
                <div className="field" style={{ flex: "1 1 240px" }}>
                  <input
                    placeholder="Search recipient, city, or request ID…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <div className="field" style={{ width: 180 }}>
                  <select
                    value={returnFilter}
                    onChange={(e) => setReturnFilter(e.target.value as "ALL" | "DIRECT" | "MANAGED")}
                  >
                    <option value="ALL">All return types</option>
                    <option value="DIRECT">Direct only</option>
                    <option value="MANAGED">Via PostNow only</option>
                  </select>
                </div>
                <div className="field" style={{ width: 180 }}>
                  <select
                    value={sortKey}
                    onChange={(e) => setSortKey(e.target.value as "oldest" | "newest" | "recipient")}
                  >
                    <option value="oldest">Oldest first</option>
                    <option value="newest">Newest first</option>
                    <option value="recipient">Recipient A–Z</option>
                  </select>
                </div>
              </div>

              {visibleDocuments.length === 0 ? (
                <div style={{ fontSize: 14, color: "var(--text-secondary)" }}>
                  No documents match your search or filter.
                </div>
              ) : (
              <DataTable
                columns={["Request ID", "Recipient", "Uploaded", "Return", "Status", "Actions"]}
                rows={visibleDocuments.map((doc) => [
                  <Link
                    key={`${doc.id}-ref`}
                    href={`/tracking/${doc.id}`}
                    style={{ fontFamily: "var(--font-mono, monospace)", fontWeight: 700, color: "var(--accent-primary)" }}
                  >
                    #{doc.id.slice(0, 8).toUpperCase()}
                  </Link>,
                  <Link key={`${doc.id}-recipient`} href={`/tracking/${doc.id}`} style={{ color: "inherit" }}>
                    <div>{doc.recipientName}</div>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{doc.city}</div>
                  </Link>,
                  timeAgo(doc.createdAt),
                  <Badge key={`${doc.id}-return`} tone={doc.returnPreference === "MANAGED" ? "teal" : "navy"}>
                    {doc.returnPreference === "MANAGED" ? "Via PostNow" : "Direct"}
                  </Badge>,
                  <StatusPill key={`${doc.id}-status`} status={doc.status} />,
                  <div key={`${doc.id}-actions`} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button className="btn btn-secondary" onClick={() => handleDownload(doc.id)}>
                        📄 Download
                      </button>
                      <button
                        className="btn btn-secondary"
                        disabled={busyId === doc.id}
                        onClick={() => handlePrintApi(doc.id)}
                      >
                        {printProvider === "EPSON_DIRECT" ? "📧" : "🖨️"}{" "}
                        {busyId === doc.id
                          ? "Sending…"
                          : printProvider === "EPSON_DIRECT"
                            ? "Email to Printer"
                            : "Print (API)"}
                      </button>
                      <button
                        className="btn btn-primary"
                        disabled={busyId === doc.id}
                        onClick={() => handleMarkPrinted(doc.id)}
                      >
                        ✅ {busyId === doc.id ? "Marking…" : "Mark Printed"}
                      </button>
                    </div>
                    {errorId?.id === doc.id && <div className="form-error">{errorId.message}</div>}
                  </div>,
                ])}
              />
              )}
            </Card>
          )}

          <Card title="Print history">
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                flexWrap: "wrap",
                marginBottom: 14,
                alignItems: "center",
              }}
            >
              <div style={{ fontSize: 13, color: "var(--text-secondary)", maxWidth: 560 }}>
                Outcomes from Epson Connect and Email Print notifications (success, failure, pending).
                Each request ID links to the document tracking page. Hover or click the outcome chip for
                the email/API detail.
              </div>
              <div className="print-history-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={historySyncing}
                  onClick={() => void refreshHistoryFromMailbox()}
                >
                  {historySyncing ? "Checking mailbox…" : "↻ Refresh from mailbox"}
                </button>
              </div>
            </div>
            {historyMsg && (
              <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 12 }}>{historyMsg}</div>
            )}
            {history.length === 0 ? (
              <div style={{ fontSize: 14, color: "var(--text-secondary)" }}>
                No print jobs recorded yet. After you print (API or Email Print), outcomes appear here —
                including Epson email confirmations once the mailbox is synced.
              </div>
            ) : (
              <DataTable
                columns={["When", "Request ID", "Recipient", "Doc status", "Print outcome", "Detail"]}
                rows={history.map((row) => [
                  <span key={`${row.id}-when`} title={new Date(row.updatedAt).toISOString()}>
                    {timeAgo(row.updatedAt)}
                  </span>,
                  <Link
                    key={`${row.id}-ref`}
                    href={`/tracking/${row.documentId}`}
                    style={{
                      fontFamily: "var(--font-mono, monospace)",
                      fontWeight: 700,
                      color: "var(--accent-primary)",
                    }}
                    title={`Open tracking for ${row.documentId}`}
                  >
                    #{row.documentId.slice(0, 10).toUpperCase()}
                  </Link>,
                  <Link
                    key={`${row.id}-name`}
                    href={`/tracking/${row.documentId}`}
                    style={{ color: "inherit" }}
                    title="Open tracking"
                  >
                    <div>{row.recipientName}</div>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>{row.city}</div>
                  </Link>,
                  <StatusPill key={`${row.id}-doc`} status={row.documentStatus} />,
                  <PrintFeedbackChip key={`${row.id}-fb`} feedback={row.feedback} size="sm" />,
                  <span
                    key={`${row.id}-detail`}
                    title={row.feedback.summary}
                    style={{ fontSize: 12, color: "var(--text-secondary)", maxWidth: 220, display: "inline-block" }}
                  >
                    {row.feedback.subject ||
                      row.feedback.snippet?.slice(0, 80) ||
                      row.feedback.summary}
                    {(row.feedback.snippet?.length ?? 0) > 80 ? "…" : ""}
                  </span>,
                ])}
              />
            )}
          </Card>
        </div>
      </main>
    </div>
  );
}
