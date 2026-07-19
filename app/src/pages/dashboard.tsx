import { useEffect, useRef, useState } from "react";
import type { GetServerSideProps } from "next";
import { getServerSession } from "next-auth/next";
import Link from "next/link";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/db";
import { AppHeader, Alert, Card, DataTable, StatusPill, PrinterStatus } from "@/components/ui";
import { FACILITY_ADDRESS } from "@/lib/facility";
import type { AddressSuggestion } from "@/pages/api/geocode/autocomplete";

interface QuoteRate {
  service_name?: string;
  service_level_code?: string;
  total_price?: number;
}

interface RateCardRate {
  courier: string;
  code: string;
  price: number;
}

interface QueueRow {
  id: string;
  recipientName: string;
  city: string;
  createdAt: string;
  returnPreference: "DIRECT" | "MANAGED";
  status: string;
}

interface FeedItem {
  time: string;
  icon: string;
  documentId: string;
  shortId: string;
  message: string;
  highlight?: boolean;
  danger?: boolean;
}

interface DashboardProps {
  userLabel: string;
  isStaff: boolean;
  facilityLabel: string;
  pipeline: {
    pending: number;
    printing: number;
    dispatched: number;
    inTransit: number;
    deliveredToday: number;
    returned: number;
  };
  today: {
    processed: number;
    exceptions: number;
    revenue: number;
  };
  printQueue: QueueRow[];
  feed: FeedItem[];
  rows: Array<{ id: string; recipientName: string; status: string }>;
  exceptions: number;
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

function feedIcon(action: string): { icon: string; highlight?: boolean; danger?: boolean } {
  if (action.includes("DELIVERED") || action.includes("->DELIVERED")) return { icon: "✅", highlight: true };
  if (action.includes("PRINTED") || action.includes("->PRINTED") || action === "epson_print_confirmed")
    return { icon: "🖨️", highlight: true };
  if (action === "uploaded") return { icon: "📥" };
  if (action.includes("DISPATCHED") || action.includes("->DISPATCHED") || action === "dispatch_created")
    return { icon: "🚚", highlight: true };
  if (action === "shipment_exception" || action === "epson_print_failed") return { icon: "⚠️", danger: true };
  if (action.includes("RETURN")) return { icon: "🔄" };
  return { icon: "📋" };
}

function feedMessage(action: string, recipientName: string, city: string): string {
  if (action === "uploaded") return `UPLOADED – ${recipientName}`;
  if (action.includes("->PRINTED") || action === "epson_print_confirmed") return `PRINTED – ${recipientName}`;
  if (action.includes("->DISPATCHED") || action === "dispatch_created") return `DISPATCHED – ${city || recipientName}`;
  if (action.includes("->IN_TRANSIT")) return `IN TRANSIT – ${city || recipientName}`;
  if (action.includes("->DELIVERED")) return `DELIVERED – ${city || recipientName}`;
  if (action === "shipment_exception") return `DELIVERY EXCEPTION – ${recipientName}`;
  if (action === "epson_print_failed") return `PRINT FAILED – ${recipientName}`;
  return `${action.replace(/_/g, " ")} – ${recipientName}`;
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

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const [
    documents,
    pending,
    printingHour,
    dispatched,
    inTransit,
    deliveredToday,
    returned,
    exceptions,
    processedToday,
    revenueAgg,
    printQueueDocs,
    recentEvents,
  ] = await Promise.all([
    prisma.document.findMany({ where, orderBy: { createdAt: "desc" }, take: 10 }),
    prisma.document.count({ where: { ...where, status: { in: ["UPLOADED", "QUEUED_FOR_PRINT"] } } }),
    prisma.document.count({
      where: { ...where, status: "PRINTED", updatedAt: { gte: oneHourAgo } },
    }),
    prisma.document.count({ where: { ...where, status: "DISPATCHED" } }),
    prisma.document.count({ where: { ...where, status: "IN_TRANSIT" } }),
    prisma.document.count({
      where: { ...where, status: "DELIVERED", updatedAt: { gte: startOfToday } },
    }),
    prisma.document.count({ where: { ...where, status: { in: ["RETURNED", "RETURN_IN_TRANSIT"] } } }),
    prisma.auditEvent.count({
      where: { action: "shipment_exception", document: where },
    }),
    prisma.document.count({
      where: {
        ...where,
        status: { in: ["PRINTED", "DISPATCHED", "IN_TRANSIT", "DELIVERED", "RETURNED"] },
        updatedAt: { gte: startOfToday },
      },
    }),
    prisma.payment.aggregate({
      where: {
        status: "PAID",
        updatedAt: { gte: startOfToday },
        document: where,
      },
      _sum: { amount: true },
    }),
    prisma.document.findMany({
      where: { ...where, status: { in: ["UPLOADED", "QUEUED_FOR_PRINT"] } },
      orderBy: { createdAt: "asc" },
      take: 8,
    }),
    prisma.auditEvent.findMany({
      where: { document: where },
      include: { document: { select: { id: true, recipientName: true, city: true } } },
      orderBy: { createdAt: "desc" },
      take: 12,
    }),
  ]);

  const facilityLabel = [FACILITY_ADDRESS.local_area, FACILITY_ADDRESS.city, FACILITY_ADDRESS.street_address]
    .filter(Boolean)
    .join(" · ") || "Secure Facility";

  const feed: FeedItem[] = recentEvents.map((e) => {
    const meta = feedIcon(e.action);
    return {
      time: e.createdAt.toISOString().slice(11, 16),
      icon: meta.icon,
      documentId: e.documentId,
      shortId: e.documentId.slice(0, 8).toUpperCase(),
      message: feedMessage(e.action, e.document.recipientName, e.document.city),
      highlight: meta.highlight,
      danger: meta.danger,
    };
  });

  return {
    props: {
      userLabel: `${user.email} · ${isStaff ? "Secure Facility" : "Customer"}`,
      isStaff,
      facilityLabel,
      pipeline: {
        pending,
        printing: printingHour,
        dispatched,
        inTransit,
        deliveredToday,
        returned,
      },
      today: {
        processed: processedToday,
        exceptions,
        revenue: revenueAgg._sum.amount ?? 0,
      },
      printQueue: printQueueDocs.map((d) => ({
        id: d.id,
        recipientName: d.recipientName,
        city: d.city,
        createdAt: d.createdAt.toISOString(),
        returnPreference: d.returnPreference,
        status: d.status,
      })),
      feed,
      rows: documents.map((d) => ({ id: d.id, recipientName: d.recipientName, status: d.status })),
      exceptions,
    },
  };
};

export default function Dashboard({
  userLabel,
  isStaff,
  facilityLabel,
  pipeline,
  today,
  printQueue,
  feed,
  rows,
  exceptions,
}: DashboardProps) {
  const [clock, setClock] = useState("");
  const [streetAddress, setStreetAddress] = useState("");
  const [localArea, setLocalArea] = useState("");
  const [city, setCity] = useState("");
  const [zone, setZone] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [coords, setCoords] = useState<{ lat?: number; lng?: number }>({});
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [rates, setRates] = useState<QuoteRate[] | null>(null);
  const [rateCardZone, setRateCardZone] = useState<"local" | "main" | "regional">("local");
  const [rateCardWeight, setRateCardWeight] = useState("0.2");
  const [rateCardLoading, setRateCardLoading] = useState(false);
  const [rateCardError, setRateCardError] = useState<string | null>(null);
  const [rateCardRates, setRateCardRates] = useState<RateCardRate[] | null>(null);
  const [showTools, setShowTools] = useState(false);

  useEffect(() => {
    const tick = () => setClock(new Date().toTimeString().slice(0, 8));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  function handleStreetAddressChange(value: string) {
    setStreetAddress(value);
    setCoords({});
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (value.trim().length < 3) {
      setSuggestions([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/geocode/autocomplete?q=${encodeURIComponent(value)}`);
        const data = await res.json();
        setSuggestions(data.suggestions ?? []);
        setShowSuggestions(true);
      } catch {
        setSuggestions([]);
      }
    }, 350);
  }

  function selectSuggestion(s: AddressSuggestion) {
    setStreetAddress(s.streetAddress);
    setLocalArea(s.localArea);
    setCity(s.city);
    setZone(s.zone);
    setPostalCode(s.postalCode);
    setCoords({ lat: s.lat, lng: s.lng });
    setSuggestions([]);
    setShowSuggestions(false);
  }

  async function handleGetQuote(e: React.FormEvent) {
    e.preventDefault();
    setQuoting(true);
    setQuoteError(null);
    setRates(null);
    try {
      const res = await fetch("/api/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ streetAddress, localArea, city, zone, postalCode, ...coords }),
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

  async function handleRateCardLookup(e: React.FormEvent) {
    e.preventDefault();
    setRateCardLoading(true);
    setRateCardError(null);
    setRateCardRates(null);
    try {
      const res = await fetch(`/api/rate-cards?zone=${rateCardZone}&weight=${encodeURIComponent(rateCardWeight)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Rate card lookup failed");
      setRateCardRates(data.rates ?? []);
    } catch (err) {
      setRateCardError((err as Error).message);
    } finally {
      setRateCardLoading(false);
    }
  }

  // ─── Customer dashboard (light) ───
  if (!isStaff) {
    return (
      <div className="app-shell">
        <AppHeader active="dashboard" userLabel={userLabel} />
        <main className="app-main">
          <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            <div className="page-head">
              <div>
                <div className="page-title">Your dispatches</div>
                <div className="page-subtitle">Track every document from upload to delivery.</div>
              </div>
              <Link href="/dispatch/new" className="btn btn-primary">
                + New Secure Dispatch
              </Link>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
              <div className="pq-stat">
                <div className="pq-stat-val">{pipeline.pending}</div>
                <div className="pq-stat-label">In intake</div>
              </div>
              <div className="pq-stat">
                <div className="pq-stat-val">{pipeline.inTransit + pipeline.dispatched}</div>
                <div className="pq-stat-label">On the way</div>
              </div>
              <div className="pq-stat">
                <div className="pq-stat-val">{pipeline.deliveredToday}</div>
                <div className="pq-stat-label">Delivered today</div>
              </div>
            </div>
            <Card title="Recent dispatches">
              {rows.length === 0 ? (
                <div style={{ fontSize: 14, color: "var(--text-secondary)" }}>
                  No documents yet.{" "}
                  <Link href="/dispatch/new" style={{ fontWeight: 600 }}>
                    Create your first secure dispatch
                  </Link>
                  .
                </div>
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

  // ─── Staff Ops Dashboard (dark wallboard) ───
  return (
    <div className="app-shell ops-shell">
      <AppHeader active="dashboard" userLabel={userLabel} showPrintQueue showRoadmap />
      <main className="ops-main">
        <div className="ops-dashboard">
          <header className="ops-header">
            <div className="ops-header-left">
              <div className="ops-logo">
                Post<span>Now</span>
              </div>
              <span className="ops-tagline">Delivered reliably.</span>
            </div>
            <div className="ops-header-right">
              <span className="ops-badge-hub">📍 {facilityLabel}</span>
              <span className="ops-clock">{clock || "—:—:—"}</span>
              {isStaff && <PrinterStatus />}
              <Link href="/dispatch/new" className="ops-cta">
                + New Dispatch
              </Link>
            </div>
          </header>

          <div className="ops-main-grid">
            <div className="ops-left">
              <div className="ops-pipeline">
                <div className="ops-pipe pending">
                  <div className="icon">📥</div>
                  <div className="count">{pipeline.pending}</div>
                  <div className="label">Pending</div>
                  <div className="sub">UPLOADED / QUEUED</div>
                </div>
                <div className="ops-pipe printing">
                  <div className="icon">🖨️</div>
                  <div className="count">{pipeline.printing}</div>
                  <div className="label">Printing</div>
                  <div className="sub">PRINTED (1h)</div>
                </div>
                <div className="ops-pipe dispatched">
                  <div className="icon">📦</div>
                  <div className="count">{pipeline.dispatched}</div>
                  <div className="label">Dispatched</div>
                  <div className="sub">AWAITING PICKUP</div>
                </div>
                <div className="ops-pipe transit">
                  <div className="icon">🚚</div>
                  <div className="count">{pipeline.inTransit}</div>
                  <div className="label">In Transit</div>
                  <div className="sub">COURIER</div>
                </div>
                <div className="ops-pipe delivered">
                  <div className="icon">✅</div>
                  <div className="count">{pipeline.deliveredToday}</div>
                  <div className="label">Delivered</div>
                  <div className="sub">TODAY</div>
                </div>
                <div className="ops-pipe returned">
                  <div className="icon">🔄</div>
                  <div className="count">{pipeline.returned}</div>
                  <div className="label">Returned</div>
                  <div className="sub">CLOSED / IN RETURN</div>
                </div>
              </div>

              <div className="ops-panel ops-panel-grow">
                <div className="ops-panel-header">
                  <span className="ops-panel-title">
                    <span className="icon">🖨️</span> Print Queue · Next Documents
                  </span>
                  <Link href="/print-queue" className="ops-panel-sub ops-link">
                    {pipeline.pending} pending · open queue →
                  </Link>
                </div>
                {printQueue.length === 0 ? (
                  <div className="ops-empty">Print queue is clear.</div>
                ) : (
                  <table className="ops-queue-table">
                    <thead>
                      <tr>
                        <th>ID</th>
                        <th>Recipient</th>
                        <th>Uploaded</th>
                        <th>Return</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {printQueue.map((doc, i) => {
                        const hours =
                          (Date.now() - new Date(doc.createdAt).getTime()) / (1000 * 60 * 60);
                        const urgent = hours >= 4;
                        return (
                          <tr key={doc.id}>
                            <td>
                              <Link href={`/tracking/${doc.id}`} className="ops-doc-id">
                                #{doc.id.slice(0, 8).toUpperCase()}
                              </Link>
                            </td>
                            <td>
                              <span className="ops-recipient">{doc.recipientName}</span>{" "}
                              <span className="ops-city">{doc.city}</span>
                            </td>
                            <td className="ops-time">{timeAgo(doc.createdAt)}</td>
                            <td>
                              <span
                                className={`ops-return ${doc.returnPreference === "DIRECT" ? "direct" : "via"}`}
                              >
                                {doc.returnPreference === "DIRECT" ? "Direct" : "Via PostNow"}
                              </span>
                            </td>
                            <td>{urgent || i === 0 ? <span className="ops-urgent">URGENT</span> : null}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            <div className="ops-right">
              <div className="ops-panel">
                <div className="ops-panel-header">
                  <span className="ops-panel-title">
                    <span className="icon">📊</span> Today&apos;s Numbers
                  </span>
                  <span className="ops-panel-sub">as of now</span>
                </div>
                <div className="ops-scoreboard">
                  <div className="ops-score">
                    <span className="number">{today.processed}</span>
                    <span className="label">Total Processed</span>
                  </div>
                  <div className="ops-score">
                    <span className="number">{pipeline.inTransit + pipeline.dispatched}</span>
                    <span className="label">Active Outbound</span>
                  </div>
                  <div className="ops-score">
                    <span className="number">{today.exceptions}</span>
                    <span className="label">Exceptions</span>
                    {today.exceptions > 0 && <span className="trend down">⚠️ needs review</span>}
                  </div>
                  <div className="ops-score">
                    <span className="number">
                      R {today.revenue.toLocaleString("en-ZA", { maximumFractionDigits: 0 })}
                    </span>
                    <span className="label">Revenue (paid today)</span>
                  </div>
                </div>
              </div>

              <div className="ops-panel ops-panel-grow">
                <div className="ops-panel-header">
                  <span className="ops-panel-title">
                    <span className="icon">📋</span> Recent Activity
                  </span>
                  <span className="ops-panel-sub">live</span>
                </div>
                <div className="ops-feed">
                  {feed.length === 0 ? (
                    <div className="ops-empty">No activity yet.</div>
                  ) : (
                    feed.map((item, i) => (
                      <div key={i} className="ops-feed-item">
                        <span className="time">{item.time}</span>
                        <span className="icon">{item.icon}</span>
                        <span className="msg">
                          <Link href={`/tracking/${item.documentId}`} className="ops-feed-doc">
                            #{item.shortId}
                          </Link>{" "}
                          <span className={item.danger ? "danger" : item.highlight ? "highlight" : undefined}>
                            {item.message}
                          </span>
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="ops-panel">
                <div className="ops-panel-header">
                  <span className="ops-panel-title">
                    <span className="icon">🗺️</span> Facility
                  </span>
                  <span className="ops-panel-sub">print &amp; dispatch hub</span>
                </div>
                <div className="ops-map-placeholder">
                  📍 {facilityLabel || "Set FACILITY_* env vars for hub address"}
                  <div className="ops-map-links">
                    <Link href="/print-queue">Print Queue</Link>
                    <Link href="/printer">Printer Hub</Link>
                    <Link href="/roadmap">Roadmap</Link>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <footer className="ops-footer">
            <span>© {new Date().getFullYear()} PostNow · Secure Facility · {facilityLabel}</span>
            <div className="ops-footer-badges">
              <span>
                <span className="dot green" /> POPIA Compliant
              </span>
              <span>
                <span className="dot teal" /> Chain of Custody Active
              </span>
              <span>🔒 Encrypted storage</span>
            </div>
          </footer>

          {exceptions > 0 && (
            <div style={{ marginTop: 8 }}>
              <Alert title="Attention required" tone="danger">
                {exceptions} shipment exception(s) need review.
              </Alert>
            </div>
          )}

          <div style={{ marginTop: 16 }}>
            <button type="button" className="ops-tools-toggle" onClick={() => setShowTools((v) => !v)}>
              {showTools ? "Hide" : "Show"} quote tools
            </button>
          </div>

          {showTools && (
            <div className="ops-tools">
              <Card title="Quote Tool">
                <form onSubmit={handleGetQuote} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                    Rates from our facility to a delivery address, via Courier Guy.
                  </div>
                  <div className="field" style={{ position: "relative" }}>
                    <label>Street Address</label>
                    <input
                      value={streetAddress}
                      onChange={(e) => handleStreetAddressChange(e.target.value)}
                      onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
                      onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                      autoComplete="off"
                      required
                    />
                    {showSuggestions && suggestions.length > 0 && (
                      <ul className="address-suggestions">
                        {suggestions.map((s, i) => (
                          <li key={i}>
                            <button type="button" onMouseDown={() => selectSuggestion(s)}>
                              {s.displayName}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
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

              <Card title="Bob Go Rate Card">
                <form onSubmit={handleRateCardLookup} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  <div className="field-row">
                    <div className="field">
                      <label>Zone</label>
                      <select
                        value={rateCardZone}
                        onChange={(e) => setRateCardZone(e.target.value as "local" | "main" | "regional")}
                      >
                        <option value="local">Local</option>
                        <option value="main">Main centre</option>
                        <option value="regional">Regional</option>
                      </select>
                    </div>
                    <div className="field">
                      <label>Weight (kg)</label>
                      <input
                        type="number"
                        step="0.1"
                        min="0.1"
                        value={rateCardWeight}
                        onChange={(e) => setRateCardWeight(e.target.value)}
                        required
                      />
                    </div>
                  </div>
                  <button type="submit" className="btn btn-primary" disabled={rateCardLoading} style={{ alignSelf: "flex-start" }}>
                    {rateCardLoading ? "Looking up…" : "Look Up Rates"}
                  </button>
                  {rateCardError && <div className="form-error">{rateCardError}</div>}
                  {rateCardRates && rateCardRates.length > 0 && (
                    <DataTable
                      columns={["Courier", "Service", "Price"]}
                      rows={rateCardRates.map((r) => [r.courier, r.code, `R${r.price.toFixed(2)}`])}
                    />
                  )}
                </form>
              </Card>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
