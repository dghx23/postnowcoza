import { useState } from "react";
import type { GetServerSideProps } from "next";
import { getServerSession } from "next-auth/next";
import Link from "next/link";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/db";
import { AppHeader, MetricTile, Alert, Card, DataTable, StatusPill, PrinterStatus } from "@/components/ui";

interface QuoteRate {
  service_name?: string;
  service_level_code?: string;
  total_price?: number;
}

interface DashboardProps {
  userLabel: string;
  isStaff: boolean;
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
      isStaff,
      metrics: { activeDispatches, inTransit, delivered, exceptions },
      rows: documents.map((d) => ({ id: d.id, recipientName: d.recipientName, status: d.status })),
    },
  };
};

export default function Dashboard({ userLabel, isStaff, metrics, rows }: DashboardProps) {
  const [streetAddress, setStreetAddress] = useState("");
  const [localArea, setLocalArea] = useState("");
  const [city, setCity] = useState("");
  const [zone, setZone] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [rates, setRates] = useState<QuoteRate[] | null>(null);

  async function handleGetQuote(e: React.FormEvent) {
    e.preventDefault();
    setQuoting(true);
    setQuoteError(null);
    setRates(null);
    try {
      const res = await fetch("/api/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ streetAddress, localArea, city, zone, postalCode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Quote request failed");
      setRates(data.rates ?? []);
    } catch (err) {
      setQuoteError((err as Error).message);
    } finally {
      setQuoting(false);
    }
  }

  return (
    <div className="app-shell">
      <AppHeader active="dashboard" userLabel={userLabel} showPrintQueue={isStaff} showRoadmap={isStaff} />
      <main className="app-main">
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div className="page-head">
            <div>
              <div className="page-title">Compliance Dashboard</div>
              <div className="page-subtitle">Zero-Touch model — upload once, we handle everything.</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              {isStaff && <PrinterStatus />}
              <Link href="/dispatch/new" className="btn btn-primary">
                + New Secure Dispatch
              </Link>
            </div>
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

          {isStaff && (
            <Card title="Quote Tool">
              <form onSubmit={handleGetQuote} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                  Rates from our facility to a delivery address, via Courier Guy.
                </div>
                <div className="field">
                  <label>Street Address</label>
                  <input value={streetAddress} onChange={(e) => setStreetAddress(e.target.value)} required />
                </div>
                <div className="field-row">
                  <div className="field">
                    <label>Suburb</label>
                    <input value={localArea} onChange={(e) => setLocalArea(e.target.value)} required />
                  </div>
                  <div className="field">
                    <label>City</label>
                    <input value={city} onChange={(e) => setCity(e.target.value)} required />
                  </div>
                </div>
                <div className="field-row">
                  <div className="field">
                    <label>Province</label>
                    <input value={zone} onChange={(e) => setZone(e.target.value)} required />
                  </div>
                  <div className="field">
                    <label>Postal Code</label>
                    <input value={postalCode} onChange={(e) => setPostalCode(e.target.value)} required />
                  </div>
                </div>
                <button type="submit" className="btn btn-primary" disabled={quoting} style={{ alignSelf: "flex-start" }}>
                  {quoting ? "Getting quote…" : "Get Quote"}
                </button>
                {quoteError && <div className="form-error">{quoteError}</div>}
                {rates && rates.length === 0 && (
                  <div style={{ fontSize: 14, color: "var(--text-secondary)" }}>
                    No rates available for that address.
                  </div>
                )}
                {rates && rates.length > 0 && (
                  <DataTable
                    columns={["Service", "Price"]}
                    rows={rates.map((r) => [
                      r.service_name ?? r.service_level_code ?? "—",
                      r.total_price != null ? `R${r.total_price.toFixed(2)}` : "—",
                    ])}
                  />
                )}
              </form>
            </Card>
          )}
        </div>
      </main>
    </div>
  );
}
