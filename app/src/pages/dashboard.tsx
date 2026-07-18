import type { GetServerSideProps } from "next";
import { getServerSession } from "next-auth/next";
import Link from "next/link";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/db";
import { AppHeader, MetricTile, Alert, Card, DataTable, StatusPill } from "@/components/ui";

interface DashboardProps {
  userLabel: string;
  metrics: { activeDispatches: number; inTransit: number; delivered: number; exceptions: number };
  rows: Array<{ id: string; recipientName: string; status: string }>;
}

export const getServerSideProps: GetServerSideProps<DashboardProps> = async (context) => {
  const session = await getServerSession(context.req, context.res, authOptions);
  if (!session?.user?.email) {
    return { redirect: { destination: "/login", permanent: false } };
  }

  const user = await prisma.user.findUnique({ where: { email: session.user.email } });
  if (!user) return { redirect: { destination: "/login", permanent: false } };

  const isStaff = user.role === "STAFF" || user.role === "ADMIN";
  const where = isStaff ? {} : { ownerId: user.id };

  const [documents, activeDispatches, inTransit, delivered, exceptions] = await Promise.all([
    prisma.document.findMany({ where, orderBy: { createdAt: "desc" }, take: 10 }),
    prisma.bobgoShipment.count({ where: { document: where } }),
    prisma.bobgoShipment.count({
      where: { document: where, trackingStatus: { in: ["collected", "in-transit", "out-for-delivery"] } },
    }),
    prisma.document.count({ where: { ...where, status: { in: ["DELIVERED", "RETURNED"] } } }),
    prisma.auditEvent.count({
      where: { action: "shipment_exception", document: where },
    }),
  ]);

  return {
    props: {
      userLabel: `${user.email} · ${isStaff ? "Secure Facility (JHB)" : "Customer"}`,
      metrics: { activeDispatches, inTransit, delivered, exceptions },
      rows: documents.map((d) => ({ id: d.id, recipientName: d.recipientName, status: d.status })),
    },
  };
};

export default function Dashboard({ userLabel, metrics, rows }: DashboardProps) {
  return (
    <div className="app-shell">
      <AppHeader active="dashboard" userLabel={userLabel} />
      <main className="app-main">
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div className="page-head">
            <div>
              <div className="page-title">Compliance Dashboard</div>
              <div className="page-subtitle">Zero-Touch model — upload once, we handle everything.</div>
            </div>
            <Link href="/dispatch/new" className="btn btn-primary">
              + New Secure Dispatch
            </Link>
          </div>

          <div style={{ display: "flex", gap: 16 }}>
            <MetricTile label="Active Dispatches" value={String(metrics.activeDispatches)} tone="teal" />
            <MetricTile label="In Transit" value={String(metrics.inTransit)} tone="navy" />
            <MetricTile label="Delivered" value={String(metrics.delivered)} tone="gold" />
            <MetricTile label="Exceptions" value={String(metrics.exceptions)} tone="teal" />
          </div>

          {metrics.exceptions === 0 ? (
            <Alert title="Document Integrity Verified">
              All active dispatches match their submitted chain-of-custody record.
            </Alert>
          ) : (
            <Alert title="Attention required">
              {metrics.exceptions} shipment exception(s) need review.
            </Alert>
          )}

          <Card title="Recent Dispatches">
            {rows.length === 0 ? (
              <div style={{ fontSize: 14, color: "var(--text-secondary)" }}>No documents yet.</div>
            ) : (
              <DataTable
                columns={["Reference", "Recipient", "Status"]}
                rows={rows.map((r) => [
                  <Link key={r.id} href={`/tracking/${r.id}`}>
                    {r.id.slice(0, 10).toUpperCase()}
                  </Link>,
                  r.recipientName,
                  <StatusPill key={r.id + "-status"} status={r.status} />,
                ])}
              />
            )}
          </Card>
        </div>
      </main>
    </div>
  );
}
