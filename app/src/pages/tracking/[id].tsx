import { useEffect, useState } from "react";
import type { GetServerSideProps } from "next";
import Link from "next/link";
import { useRouter } from "next/router";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/db";
import {
  AppHeader,
  Card,
  DataTable,
  Badge,
  StatusPill,
  TrackingTimeline,
  Alert,
  PrintFeedbackChip,
  type TimelineEvent,
} from "@/components/ui";
import { buildPrintFeedback, type PrintFeedbackDetail } from "@/lib/printFeedback";

interface LiveCheckpoint {
  date: string;
  status: string;
  location?: string;
  message?: string;
}

interface LiveTrackingState {
  loading: boolean;
  notBooked: boolean;
  error: string | null;
  trackingReference: string | null;
  status: string | null;
  events: LiveCheckpoint[];
}

const STAGE_ORDER = [
  "UPLOADED",
  "QUEUED_FOR_PRINT",
  "PRINTED",
  "DISPATCHED",
  "IN_TRANSIT",
  "DELIVERED",
  "RETURN_REQUESTED",
  "RETURN_IN_TRANSIT",
  "RETURNED",
];
const STAGE_LABELS: Record<string, string> = {
  UPLOADED: "Submitted",
  QUEUED_FOR_PRINT: "Secure Intake",
  PRINTED: "Secure Intake & Printing",
  DISPATCHED: "Professional Dispatch",
  IN_TRANSIT: "Physical Delivery & Signing",
  DELIVERED: "Delivered",
  RETURN_REQUESTED: "Return Pathway",
  RETURN_IN_TRANSIT: "Return in Transit",
  RETURNED: "Record, Audit & Completion",
};

interface TrackingProps {
  userLabel: string;
  documentId: string;
  recipientName: string;
  status: string;
  isStaff: boolean;
  timeline: TimelineEvent[];
  logRows: Array<{ time: string; event: string }>;
  /** Latest printer confirmation from Epson API or email notifications. */
  printFeedback: PrintFeedbackDetail | null;
  payment: {
    status: string | null;
    amount: number | null;
    paymentUrl: string | null;
    /** Fee is set and not yet paid — show Pay CTA */
    canPay: boolean;
  };
  dispatch: {
    recipientEmail: string;
    recipientPhone: string;
    streetAddress: string;
    localArea: string;
    city: string;
    zone: string;
    postalCode: string;
    returnPreference: "DIRECT" | "MANAGED";
    createdAt: string;
  };
}

const EARLY_STATUSES = new Set(["UPLOADED", "QUEUED_FOR_PRINT", "PRINTED"]);

// Friendly, plain-language versions of raw AuditEvent.action strings for the
// chain-of-custody log - customers (and staff) shouldn't have to parse
// "status_changed:UPLOADED->PRINTED" or internal action names.
function formatAuditAction(action: string): string {
  if (action.startsWith("status_changed:")) {
    const [, transition] = action.split(":");
    const [, to] = transition.split("->");
    return `Status updated: ${STAGE_LABELS[to] ?? to}`;
  }
  const KNOWN: Record<string, string> = {
    uploaded: "Document securely uploaded",
    document_downloaded: "Document downloaded by staff",
    dispatch_created: "Courier dispatch booked",
    return_requested: "Return dispatch requested",
    epson_print_failed: "Printer reported a print failure",
    email_print_failed: "Email Print submission failed",
    epson_print_confirmed: "Printer confirmed print completed",
    bobgo_webhook_received: "Courier status update received",
    pod_fetch_failed: "Proof-of-delivery fetch failed",
    shipment_exception: "Courier reported a delivery exception",
    payment_amount_mismatch: "Payment amount mismatch detected",
    payment_validation_failed: "Payment validation failed",
    audit_viewed: "Audit log viewed",
  };
  if (KNOWN[action]) return KNOWN[action];
  if (action.startsWith("payment_")) return `Payment ${action.slice("payment_".length)}`;
  return action.split("_").join(" ").replace(/^./, (c) => c.toUpperCase());
}

export const getServerSideProps: GetServerSideProps<TrackingProps> = async (context) => {
  const session = await getServerSession(context.req, context.res, authOptions);
  if (!session?.user?.email) {
    return { redirect: { destination: "/login", permanent: false } };
  }

  const id = context.params?.id as string;
  const document = await prisma.document.findUnique({
    where: { id },
    include: { auditEvents: { orderBy: { createdAt: "asc" } } },
  });

  if (!document) return { notFound: true };

  const user = await prisma.user.findUnique({ where: { email: session.user.email } });
  const isStaff = user?.role === "STAFF" || user?.role === "ADMIN";
  if (!isStaff && document.ownerId !== user?.id) {
    return { redirect: { destination: "/dashboard", permanent: false } };
  }

  const currentIndex = STAGE_ORDER.indexOf(document.status);
  const timeline: TimelineEvent[] = STAGE_ORDER.slice(0, 6).map((stage, i) => ({
    label: STAGE_LABELS[stage],
    state: i < currentIndex ? "done" : i === currentIndex ? "current" : "pending",
  }));

  const logRows = document.auditEvents.map((e) => ({
    time: e.createdAt.toISOString().slice(11, 16),
    event: formatAuditAction(e.action),
  }));

  const latestPrintJob = await prisma.epsonPrintJob.findFirst({
    where: { documentId: id },
    orderBy: { createdAt: "desc" },
  });

  const printAudit = [...document.auditEvents]
    .reverse()
    .find((e) =>
      ["epson_print_confirmed", "epson_print_failed", "email_print_failed"].includes(e.action),
    );

  const printFeedback = buildPrintFeedback({
    jobStatus: latestPrintJob?.status,
    jobId: latestPrintJob?.jobId,
    jobUpdatedAt: latestPrintJob?.updatedAt,
    auditAction: printAudit?.action,
    auditMetadata: printAudit?.metadata,
    auditAt: printAudit?.createdAt,
    documentStatus: document.status,
  });

  const latestPayment = await prisma.payment.findFirst({
    where: { documentId: id },
    orderBy: { createdAt: "desc" },
  });

  const fee = document.dispatchFee ?? null;
  const paymentStatus = latestPayment?.status ?? null;

  return {
    props: {
      userLabel: session.user.email ?? "",
      documentId: document.id,
      recipientName: document.recipientName,
      status: document.status,
      isStaff,
      timeline,
      logRows,
      printFeedback,
      payment: {
        status: paymentStatus,
        amount: fee,
        paymentUrl: latestPayment?.paymentUrl ?? null,
        canPay: Boolean(
          fee != null &&
            fee > 0 &&
            paymentStatus !== "PAID" &&
            (paymentStatus === "UNPAID" ||
              paymentStatus === null ||
              paymentStatus === "FAILED" ||
              paymentStatus === "CANCELLED"),
        ),
      },
      dispatch: {
        recipientEmail: document.recipientEmail,
        recipientPhone: document.recipientPhone,
        streetAddress: document.streetAddress,
        localArea: document.localArea,
        city: document.city,
        zone: document.zone,
        postalCode: document.postalCode,
        returnPreference: document.returnPreference,
        createdAt: document.createdAt.toISOString(),
      },
    },
  };
};

export default function Tracking({
  userLabel,
  documentId,
  recipientName,
  status,
  isStaff,
  timeline,
  logRows,
  printFeedback: initialPrintFeedback,
  payment: initialPayment,
  dispatch,
}: TrackingProps) {
  const router = useRouter();
  const [live, setLive] = useState<LiveTrackingState>({
    loading: true,
    notBooked: false,
    error: null,
    trackingReference: null,
    status: null,
    events: [],
  });
  const [justSubmitted, setJustSubmitted] = useState(false);
  const [paymentBanner, setPaymentBanner] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [printFeedback, setPrintFeedback] = useState(initialPrintFeedback);
  const [docStatus, setDocStatus] = useState(status);
  const [payment] = useState(initialPayment);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  useEffect(() => {
    if (!router.isReady) return;
    const q = router.query;
    if (q.submitted === "1") {
      setJustSubmitted(true);
    }
    if (q.payment === "success") setPaymentBanner("Payment received — thank you. We’ll continue processing your dispatch.");
    if (q.payment === "pending") setPaymentBanner("Payment is pending confirmation. This page will update when it clears.");
    if (q.payment === "cancelled") setPaymentBanner("Payment was cancelled. You can pay the dispatch fee anytime from this page once it’s ready.");

    if (q.submitted === "1" || q.payment) {
      const { submitted: _s, payment: _p, ...rest } = q;
      router.replace({ pathname: router.pathname, query: rest }, undefined, { shallow: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady]);

  function copyTrackingLink() {
    const url =
      typeof window !== "undefined"
        ? `${window.location.origin}/tracking/${documentId}`
        : `/tracking/${documentId}`;
    navigator.clipboard.writeText(url).then(() => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    });
  }

  async function handlePay() {
    // Dedicated PayFast checkout page (form POST + ITN webhook).
    router.push(`/pay/${documentId}`);
  }

  const isEarly = EARLY_STATUSES.has(docStatus);
  const stageLabel = STAGE_LABELS[docStatus] ?? docStatus;

  // Refresh printer email confirmation while pending (IMAP sync runs server-side).
  useEffect(() => {
    let cancelled = false;
    async function pollPrint() {
      try {
        const res = await fetch(`/api/documents/${documentId}/print-feedback`);
        if (!res.ok) return;
        const json = await res.json();
        if (cancelled) return;
        if (json.feedback) setPrintFeedback(json.feedback);
        if (typeof json.documentStatus === "string") setDocStatus(json.documentStatus);
      } catch {
        /* ignore */
      }
    }
    pollPrint();
    const interval = setInterval(pollPrint, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [documentId]);

  useEffect(() => {
    let cancelled = false;

    async function fetchLive() {
      try {
        const res = await fetch(`/api/documents/${documentId}/live-tracking`);
        if (res.status === 404) {
          if (!cancelled) setLive((s) => ({ ...s, loading: false, notBooked: true }));
          return;
        }
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Unable to reach courier");
        if (!cancelled) {
          setLive({
            loading: false,
            notBooked: false,
            error: null,
            trackingReference: json.trackingReference,
            status: json.status,
            events: json.events ?? [],
          });
        }
      } catch (err) {
        if (!cancelled) {
          setLive((s) => ({ ...s, loading: false, error: (err as Error).message }));
        }
      }
    }

    fetchLive();
    const interval = setInterval(fetchLive, 60000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [documentId]);

  return (
    <div className="app-shell">
      <AppHeader active="tracking" userLabel={userLabel} showPrintQueue={isStaff} showRoadmap={isStaff} />
      <main className="app-main">
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          {(justSubmitted || isEarly) && (
            <Card title={justSubmitted ? "✅ Document received securely" : "Your dispatch hub"}>
              <div className="post-submit-panel">
                <p className="post-submit-lead">
                  {justSubmitted
                    ? "You’re all set — this is your live tracking page for this dispatch. We’ve taken custody of the document and will handle printing, courier booking, and delivery updates here."
                    : `Current stage: ${stageLabel}. This page is the home for this dispatch — status, payment, and courier updates all land here.`}
                </p>

                <div className="post-submit-steps">
                  <div className="post-submit-step done">
                    <span className="post-submit-step-num">1</span>
                    <div>
                      <strong>Submitted</strong>
                      <div className="post-submit-step-meta">Document encrypted and stored with chain of custody</div>
                    </div>
                  </div>
                  <div className={`post-submit-step${docStatus !== "UPLOADED" ? " done" : " current"}`}>
                    <span className="post-submit-step-num">2</span>
                    <div>
                      <strong>Secure intake &amp; printing</strong>
                      <div className="post-submit-step-meta">Our facility prints for wet-ink signature handling</div>
                    </div>
                  </div>
                  <div
                    className={`post-submit-step${
                      ["DISPATCHED", "IN_TRANSIT", "DELIVERED", "RETURN_REQUESTED", "RETURN_IN_TRANSIT", "RETURNED"].includes(
                        docStatus,
                      )
                        ? " done"
                        : docStatus === "PRINTED"
                          ? " current"
                          : ""
                    }`}
                  >
                    <span className="post-submit-step-num">3</span>
                    <div>
                      <strong>Dispatch fee &amp; courier</strong>
                      <div className="post-submit-step-meta">
                        When the dispatch fee is set, you can pay here; live courier tracking appears after booking
                      </div>
                    </div>
                  </div>
                  <div className={`post-submit-step${docStatus === "DELIVERED" || docStatus === "RETURNED" ? " done" : ""}`}>
                    <span className="post-submit-step-num">4</span>
                    <div>
                      <strong>Delivery &amp; return</strong>
                      <div className="post-submit-step-meta">
                        {dispatch.returnPreference === "MANAGED"
                          ? "Fully managed return via PostNow after signing"
                          : "Direct return pathway after signing"}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="post-submit-actions">
                  {payment.canPay && (
                    <button type="button" className="btn btn-primary" disabled={paying} onClick={() => void handlePay()}>
                      {paying
                        ? "Opening payment…"
                        : payment.amount != null
                          ? `Pay dispatch fee · R${payment.amount.toFixed(2)}`
                          : "Pay dispatch fee"}
                    </button>
                  )}
                  {payment.status === "PAID" && (
                    <Badge tone="success">Dispatch fee paid</Badge>
                  )}
                  <button type="button" className="btn btn-secondary" onClick={copyTrackingLink}>
                    {linkCopied ? "✓ Link copied" : "🔗 Copy tracking link"}
                  </button>
                  <Link href="/dashboard" className="btn btn-secondary">
                    ← Back to dashboard
                  </Link>
                  <Link href="/dispatch/new" className="btn btn-secondary">
                    + New dispatch
                  </Link>
                </div>
                {payError && <div className="form-error">{payError}</div>}
                {!payment.canPay && payment.amount == null && isEarly && (
                  <p className="post-submit-note">
                    Payment isn’t due yet — the dispatch fee appears on this page once the shipment is rated and
                    booked. Bookmark this tracking link to return anytime.
                  </p>
                )}
              </div>
            </Card>
          )}

          {paymentBanner && (
            <Alert title="Payment update" tone={paymentBanner.includes("cancelled") ? "danger" : "success"}>
              {paymentBanner}
            </Alert>
          )}

          <div className="page-head">
            <div>
              <div className="page-title">{documentId.slice(0, 10).toUpperCase()}</div>
              <div className="page-subtitle">
                {recipientName}
                <span style={{ color: "var(--text-secondary)", fontWeight: 500 }}> · {stageLabel}</span>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              {!justSubmitted && !isEarly && (
                <button type="button" className="btn btn-secondary" onClick={copyTrackingLink}>
                  {linkCopied ? "✓ Link copied" : "🔗 Copy tracking link"}
                </button>
              )}
              {payment.canPay && !justSubmitted && !isEarly && (
                <button type="button" className="btn btn-primary" disabled={paying} onClick={() => void handlePay()}>
                  {paying ? "Opening…" : `Pay R${(payment.amount ?? 0).toFixed(2)}`}
                </button>
              )}
              <StatusPill status={docStatus} />
              {printFeedback && <PrintFeedbackChip feedback={printFeedback} />}
            </div>
          </div>

          {printFeedback &&
            (printFeedback.status === "completed" ||
              printFeedback.status === "error_occurred" ||
              printFeedback.status === "expired") && (
              <Alert
                title={
                  printFeedback.status === "completed"
                    ? "Printer confirmed this document"
                    : "Printer reported a problem"
                }
                tone={printFeedback.status === "completed" ? "success" : "danger"}
              >
                <span title={printFeedback.summary}>
                  {printFeedback.label}
                  {printFeedback.subject ? ` — ${printFeedback.subject}` : ""}
                  {printFeedback.snippet && !printFeedback.subject
                    ? ` — ${printFeedback.snippet.slice(0, 140)}${printFeedback.snippet.length > 140 ? "…" : ""}`
                    : ""}{" "}
                </span>
                <PrintFeedbackChip feedback={printFeedback} size="sm" />
              </Alert>
            )}

          <div style={{ display: "flex", gap: 24, alignItems: "flex-start", flexWrap: "wrap" }}>
            <div style={{ width: 320, flex: "0 1 320px", display: "flex", flexDirection: "column", gap: 16 }}>
              <Card title="Tracking Status">
                <TrackingTimeline events={timeline} />
              </Card>
              <Card title="Dispatch Summary">
                <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
                  <div>
                    <span style={{ color: "var(--text-secondary)" }}>Delivering to: </span>
                    {dispatch.streetAddress}, {dispatch.localArea}, {dispatch.city}, {dispatch.zone}{" "}
                    {dispatch.postalCode}
                  </div>
                  <div>
                    <span style={{ color: "var(--text-secondary)" }}>Contact: </span>
                    {dispatch.recipientEmail} · {dispatch.recipientPhone}
                  </div>
                  <div>
                    <span style={{ color: "var(--text-secondary)" }}>Return preference: </span>
                    {dispatch.returnPreference === "MANAGED" ? "Fully Managed via PostNow" : "Direct Return"}
                  </div>
                  <div>
                    <span style={{ color: "var(--text-secondary)" }}>Submitted: </span>
                    {new Date(dispatch.createdAt).toLocaleString([], {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </div>
                  {payment.amount != null && (
                    <div>
                      <span style={{ color: "var(--text-secondary)" }}>Dispatch fee: </span>
                      R{payment.amount.toFixed(2)}
                      {payment.status === "PAID" ? " · Paid" : payment.status === "UNPAID" ? " · Unpaid" : ""}
                    </div>
                  )}
                  {printFeedback && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
                      <span style={{ color: "var(--text-secondary)" }}>Printer: </span>
                      <PrintFeedbackChip feedback={printFeedback} size="sm" />
                    </div>
                  )}
                </div>
              </Card>
            </div>
            <div style={{ flex: "1 1 360px", display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
              <Card title="Live Courier Tracking">
                {live.loading ? (
                  <div style={{ fontSize: 14, color: "var(--text-secondary)" }}>Checking courier status…</div>
                ) : live.notBooked ? (
                  <div style={{ fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.5 }}>
                    {isEarly ? (
                      <>
                        <strong style={{ color: "var(--navy-900)" }}>Courier not booked yet — that’s expected.</strong>
                        <br />
                        After secure intake and printing, we book the courier and live checkpoints will show here
                        automatically. Keep this page (or your dashboard) for updates.
                      </>
                    ) : (
                      <>No courier shipment has been booked for this document yet.</>
                    )}
                  </div>
                ) : live.error ? (
                  <div style={{ fontSize: 14, color: "var(--text-secondary)" }}>
                    Live tracking is temporarily unavailable ({live.error}).
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <Badge tone="teal">Ref: {live.trackingReference}</Badge>
                      {live.status && <StatusPill status={live.status} />}
                    </div>
                    {live.events.length === 0 ? (
                      <div style={{ fontSize: 14, color: "var(--text-secondary)" }}>
                        No tracking checkpoints from the courier yet.
                      </div>
                    ) : (
                      <DataTable
                        columns={["Date", "Status", "Location", "Message"]}
                        rows={live.events.map((e) => [
                          new Date(e.date).toLocaleString([], {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          }),
                          e.status,
                          e.location ?? "—",
                          e.message ?? "—",
                        ])}
                      />
                    )}
                  </div>
                )}
              </Card>
              <Card title="Chain of Custody Log">
                {logRows.length === 0 ? (
                  <div style={{ fontSize: 14, color: "var(--text-secondary)" }}>No events recorded yet.</div>
                ) : (
                  <DataTable
                    columns={["Time", "Event"]}
                    rows={logRows.map((r) => [r.time, r.event])}
                  />
                )}
              </Card>
              <Card title="Compliance">
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Badge tone="success">POPIA Compliant</Badge>
                  <Badge tone="success">Wet-Ink Verified</Badge>
                  <Badge tone="navy">Zero-Touch</Badge>
                </div>
              </Card>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
