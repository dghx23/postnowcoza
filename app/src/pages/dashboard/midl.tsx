import { useState } from "react";
import type { GetServerSideProps } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/db";
import { AppHeader, Card, DataTable, StatusPill } from "@/components/ui";

interface DealRow {
  id: string;
  reference: string;
  plan: string;
  state: string;
  itemName: string;
  itemValueCents: number;
  buyerEmail: string;
  sellerEmail: string;
  createdAt: string;
}

interface MidlDashboardProps {
  userLabel: string;
  deals: DealRow[];
  stats: {
    activeCount: number;
    totalHeldCents: number;
    releasedCount: number;
  };
}

const PLAN_LABEL: Record<string, string> = {
  ESSENTIALS: "Essentials",
  STANDARD: "Standard",
  VERIFIED_DELIVERY: "Verified Delivery",
  PREMIUM_VAULT: "Premium Vault",
};

function rand(cents: number) {
  return `R${(cents / 100).toLocaleString("en-ZA", { minimumFractionDigits: 2 })}`;
}

export default function MidlDashboard({ userLabel, deals, stats }: MidlDashboardProps) {
  const [form, setForm] = useState({
    itemName: "",
    itemValue: "",
    plan: "STANDARD",
    buyerEmail: "",
    sellerEmail: "",
    deliveryStreet: "",
    deliveryCity: "",
    deliveryProvince: "",
    deliveryPostal: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function createDeal(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setMessage(null);
    try {
      const res = await fetch("/api/deals/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(data.error ?? "Failed to create escrow");
      } else {
        setMessage(`Created ${data.deal.reference}`);
        window.location.reload();
      }
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="app-shell">
      <AppHeader active="midl" userLabel={userLabel} showPrintQueue showExpress showGlobeme showMidl />
      <main className="app-main">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 24 }}>
          <Card title="Active escrows">
            <div style={{ fontSize: "2rem", fontWeight: 800 }}>{stats.activeCount}</div>
          </Card>
          <Card title="Total held in trust">
            <div style={{ fontSize: "2rem", fontWeight: 800 }}>{rand(stats.totalHeldCents)}</div>
          </Card>
          <Card title="Released to date">
            <div style={{ fontSize: "2rem", fontWeight: 800 }}>{stats.releasedCount}</div>
          </Card>
        </div>

        <Card title="Midl — New Escrow (staff manual entry)">
          <form onSubmit={createDeal} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, maxWidth: 720 }}>
            <input placeholder="Item name" required value={form.itemName}
              onChange={(e) => setForm({ ...form, itemName: e.target.value })} />
            <input placeholder="Item value (ZAR)" type="number" required value={form.itemValue}
              onChange={(e) => setForm({ ...form, itemValue: e.target.value })} />
            <select value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })}>
              <option value="ESSENTIALS">Essentials (3% + courier)</option>
              <option value="STANDARD">Standard (8% all-inclusive)</option>
              <option value="VERIFIED_DELIVERY">Verified Delivery (10% all-inclusive)</option>
              <option value="PREMIUM_VAULT">Premium Vault (12% all-inclusive)</option>
            </select>
            <div />
            <input placeholder="Buyer email" type="email" required value={form.buyerEmail}
              onChange={(e) => setForm({ ...form, buyerEmail: e.target.value })} />
            <input placeholder="Seller email" type="email" required value={form.sellerEmail}
              onChange={(e) => setForm({ ...form, sellerEmail: e.target.value })} />
            <input placeholder="Delivery street" required value={form.deliveryStreet}
              onChange={(e) => setForm({ ...form, deliveryStreet: e.target.value })} />
            <input placeholder="Delivery city" required value={form.deliveryCity}
              onChange={(e) => setForm({ ...form, deliveryCity: e.target.value })} />
            <input placeholder="Delivery province" required value={form.deliveryProvince}
              onChange={(e) => setForm({ ...form, deliveryProvince: e.target.value })} />
            <input placeholder="Delivery postal code" required value={form.deliveryPostal}
              onChange={(e) => setForm({ ...form, deliveryPostal: e.target.value })} />
            <button type="submit" disabled={submitting} style={{ gridColumn: "1 / -1" }}>
              {submitting ? "Creating…" : "Create escrow (draft)"}
            </button>
          </form>
          {message && <p style={{ marginTop: 8 }}>{message}</p>}
          <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginTop: 8 }}>
            Buyer and seller must already have accounts (matched by email). This creates a <code>DRAFT</code> deal only —
            it does not collect payment. Funding, dispatch, and release still need the PayFast/Bob Go wiring described
            in <code>docs/POSTNOW_INFRA_REUSE.md</code> in the <code>midl</code> repo.
          </p>
        </Card>

        <Card title="Midl — Escrow Deals">
          {deals.length === 0 ? (
            <p style={{ color: "var(--text-secondary)" }}>No deals yet.</p>
          ) : (
            <DataTable
              columns={["Ref", "Plan", "Item", "Value", "Buyer", "Seller", "Status", "Created"]}
              rows={deals.map((d) => [
                d.reference,
                PLAN_LABEL[d.plan] ?? d.plan,
                d.itemName,
                rand(d.itemValueCents),
                d.buyerEmail,
                d.sellerEmail,
                <StatusPill key={d.id} status={d.state} />,
                new Date(d.createdAt).toLocaleDateString(),
              ])}
            />
          )}
        </Card>
      </main>
    </div>
  );
}

export const getServerSideProps: GetServerSideProps<MidlDashboardProps> = async (context) => {
  const session = await getServerSession(context.req, context.res, authOptions);
  if (!session?.user?.email) {
    return { redirect: { destination: "/login", permanent: false } };
  }

  const user = await prisma.user.findUnique({ where: { email: session.user.email } });
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return { redirect: { destination: "/login", permanent: false } };
  }

  const deals = await prisma.deal.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { buyer: true, seller: true },
  });

  const activeCount = deals.filter((d) => !["RELEASED", "REFUNDED", "CANCELLED"].includes(d.state)).length;
  const releasedCount = deals.filter((d) => d.state === "RELEASED").length;
  const totalHeldCents = deals
    .filter((d) => !["RELEASED", "REFUNDED", "CANCELLED"].includes(d.state))
    .reduce((sum, d) => sum + d.totalHeldCents, 0);

  return {
    props: {
      userLabel: user.email,
      deals: deals.map((d) => ({
        id: d.id,
        reference: d.reference,
        plan: d.plan,
        state: d.state,
        itemName: d.itemName,
        itemValueCents: d.itemValueCents,
        buyerEmail: d.buyer.email,
        sellerEmail: d.seller.email,
        createdAt: d.createdAt.toISOString(),
      })),
      stats: { activeCount, totalHeldCents, releasedCount },
    },
  };
};
