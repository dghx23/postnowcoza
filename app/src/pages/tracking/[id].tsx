import type { GetServerSideProps } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/db";
import { AppHeader, Card, DataTable, Badge, StatusPill, TrackingTimeline, type TimelineEvent } from "@/components/ui";

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
    event: e.action.split("_").join(" "),
  }));

  return {
    props: {
      userLabel: session.user.email,
      documentId: document.id,
      recipientName: document.recipientName,
      status: document.status,
      timeline,
      logRows,
    },
  };
};

export default function Tracking({ userLabel, documentId, recipientName, status, timeline, logRows }: TrackingProps) {
  return (
    <div className="app-shell">
      <AppHeader active="tracking" userLabel={userLabel} />
      <main className="app-main">
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div className="page-head">
            <div>
              <div className="page-title">{documentId.slice(0, 10).toUpperCase()}</div>
              <div className="page-subtitle">{recipientName}</div>
            </div>
            <StatusPill status={status} />
          </div>

          <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
            <div style={{ width: 320, flexShrink: 0 }}>
              <Card title="Tracking Status">
                <TrackingTimeline events={timeline} />
              </Card>
            </div>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 16 }}>
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
