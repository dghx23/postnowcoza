import type { NextApiRequest, NextApiResponse } from "next";
import type { DealPlan } from "@prisma/client";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/db";
import { appendAuditEvent } from "@/lib/audit";

// Fee percentages mirror the mockup's pricing table (index.html in the
// `midl` repo) and BACKEND_DESIGN.md's plan definitions. Essentials'
// courier cost is billed separately (courierPayer), so it has no
// courier % baked into the fee the way the other three plans do.
const PLAN_FEE_BPS: Record<string, number> = {
  ESSENTIALS: 300, // 3%
  STANDARD: 800, // 8%
  VERIFIED_DELIVERY: 1000, // 10%
  PREMIUM_VAULT: 1200, // 12%
};

function generateReference() {
  const n = Math.floor(1000 + Math.random() * 9000);
  return `MIDL-${n}`;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = await getServerSession(req, res, authOptions);
  if (!session?.user?.email) return res.status(401).json({ error: "Unauthorized" });

  const staffUser = await prisma.user.findUnique({ where: { email: session.user.email } });
  if (!staffUser || (staffUser.role !== "STAFF" && staffUser.role !== "ADMIN")) {
    return res.status(403).json({ error: "Staff only" });
  }

  const {
    itemName,
    itemValue,
    plan,
    buyerEmail,
    sellerEmail,
    deliveryStreet,
    deliveryCity,
    deliveryProvince,
    deliveryPostal,
  } = req.body ?? {};

  if (!itemName || !itemValue || !plan || !buyerEmail || !sellerEmail) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  if (!PLAN_FEE_BPS[plan]) {
    return res.status(400).json({ error: `Unknown plan: ${plan}` });
  }

  const buyer = await prisma.user.findUnique({ where: { email: buyerEmail } });
  const seller = await prisma.user.findUnique({ where: { email: sellerEmail } });
  if (!buyer) return res.status(404).json({ error: `No account found for buyer ${buyerEmail}` });
  if (!seller) return res.status(404).json({ error: `No account found for seller ${sellerEmail}` });

  const itemValueCents = Math.round(Number(itemValue) * 100);
  if (!Number.isFinite(itemValueCents) || itemValueCents <= 0) {
    return res.status(400).json({ error: "Invalid item value" });
  }
  const feeCents = Math.round((itemValueCents * PLAN_FEE_BPS[plan]) / 10000);
  const courierPayer = plan === "ESSENTIALS" ? "BUYER" : "INCLUDED";

  const deal = await prisma.deal.create({
    data: {
      reference: generateReference(),
      plan: plan as DealPlan,
      state: "DRAFT",
      buyerId: buyer.id,
      sellerId: seller.id,
      itemName,
      itemValueCents,
      feeCents,
      courierPayer,
      // Nothing is held yet — totalHeldCents populates once the funding
      // step actually runs (still unbuilt; see docs/POSTNOW_INFRA_REUSE.md).
      totalHeldCents: 0,
      deliveryStreet: deliveryStreet ?? "",
      deliveryCity: deliveryCity ?? "",
      deliveryProvince: deliveryProvince ?? "",
      deliveryPostal: deliveryPostal ?? "",
    },
  });

  await appendAuditEvent({
    dealId: deal.id,
    actorId: staffUser.id,
    action: "deal_created",
    metadata: { plan, itemValueCents, buyerEmail, sellerEmail },
  });

  return res.status(200).json({ deal });
}
