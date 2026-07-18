import { useEffect, useState } from "react";
import type { GetServerSideProps } from "next";
import { useRouter } from "next/router";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/db";
import { AppHeader, Card, DataTable, Badge, StatusPill, TrackingTimeline, Alert, type TimelineEvent } from "@/components/ui";

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
  timeline: TimelineEvent[];
  logRows: Array<{ time: string; event: string }>;
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
    epson_print_failed: "Print attempt failed (retried automatically)",
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

  return {
    props: {
      userLabel: session.user.email,
      documentId: document.id,
      recipientName: document.recipientName,
      status: document.status,
      timeline,
      logRows,
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
  timeline,
  logRows,
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
  const [linkCopied, setLinkCopied] = useState(false);

  useEffect(() => {
    if (!router.isReady) return;
    if (router.query.submitted === "1") {
      setJustSubmitted(true);
      const { submitted: _drop, ...rest } = router.query;
      router.replace({ pathname: router.pathname, query: rest }, undefined, { shallow: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady]);

  function copyTrackingLink() {
    navigator.clipboard.writeText(window.location.href).then(() => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    });
  }

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
      <AppHeader active="tracking" userLabel={userLabel} />
      <main className="app-main">
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          {justSubmitted && (
            <Alert title="✅ Document received securely">
              Your document is now in our secure custody. This page will keep updating as it moves through
              printing, dispatch, and delivery — bookmark it or copy the link below to check back anytime.
            </Alert>
          )}

          <div className="page-head">
            <div>
              <div className="page-title">{documentId.slice(0, 10).toUpperCase()}</div>
              <div className="page-subtitle">{recipientName}</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <button type="button" className="btn btn-secondary" onClick={copyTrackingLink}>
                {linkCopied ? "✓ Link copied" : "🔗 Copy tracking link"}
              </button>
              <StatusPill status={status} />
            </div>
          </div>

          <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
            <div style={{ width: 320, flexShrink: 0, display: "flex", flexDirection: "column", gap: 16 }}>
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
                </div>
              </Card>
            </div>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 16 }}>
              <Card title="Live Courier Tracking">
                {live.loading ? (
                  <div style={{ fontSize: 14, color: "var(--text-secondary)" }}>Checking courier status…</div>
                ) : live.notBooked ? (
                  <div style={{ fontSize: 14, color: "var(--text-secondary)" }}>
                    No courier shipment has been booked for this document yet.
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
