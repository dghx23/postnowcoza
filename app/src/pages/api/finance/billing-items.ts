import type { NextApiRequest, NextApiResponse } from "next";
import { getSessionUser } from "@/lib/session";
import { prisma } from "@/lib/db";
import { logSyncException } from "@/lib/syncExceptions";

/**
 * Staff payment-structure workspace (rates / billing lines → ledger → Zoho).
 * GET  — list items
 * POST — create { code, name, amount, description?, zohoItemId?, notes? }
 * PUT  — update { id, ...fields }
 * DELETE — { id } soft-deactivate (active=false) or hard if ?hard=1
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await getSessionUser(req, res);
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return res.status(403).json({ error: "Forbidden" });
  }

  if (req.method === "GET") {
    const items = await prisma.billingItem.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });
    return res.status(200).json({ items });
  }

  if (req.method === "POST") {
    const body = req.body ?? {};
    const code = String(body.code ?? "").trim().toUpperCase();
    const name = String(body.name ?? "").trim();
    const amount = Number(body.amount);
    if (!code || !name || !Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ error: "code, name, and non-negative amount required" });
    }
    try {
      const item = await prisma.billingItem.create({
        data: {
          code,
          name,
          amount,
          description: body.description ? String(body.description).trim() : null,
          zohoItemId: body.zohoItemId ? String(body.zohoItemId).trim() : null,
          notes: body.notes ? String(body.notes).trim() : null,
          sortOrder: Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : 0,
        },
      });
      return res.status(201).json({ item });
    } catch (err) {
      const message = (err as Error).message;
      await logSyncException({
        source: "payment_structure",
        title: "Could not create billing item",
        detail: message,
      });
      return res.status(400).json({ error: message });
    }
  }

  if (req.method === "PUT") {
    const body = req.body ?? {};
    const id = String(body.id ?? "");
    if (!id) return res.status(400).json({ error: "id required" });
    try {
      const item = await prisma.billingItem.update({
        where: { id },
        data: {
          ...(body.code != null ? { code: String(body.code).trim().toUpperCase() } : {}),
          ...(body.name != null ? { name: String(body.name).trim() } : {}),
          ...(body.amount != null ? { amount: Number(body.amount) } : {}),
          ...(body.description !== undefined
            ? { description: body.description ? String(body.description) : null }
            : {}),
          ...(body.zohoItemId !== undefined
            ? { zohoItemId: body.zohoItemId ? String(body.zohoItemId) : null }
            : {}),
          ...(body.notes !== undefined ? { notes: body.notes ? String(body.notes) : null } : {}),
          ...(body.active != null ? { active: Boolean(body.active) } : {}),
          ...(body.sortOrder != null ? { sortOrder: Number(body.sortOrder) } : {}),
        },
      });
      return res.status(200).json({ item });
    } catch (err) {
      const message = (err as Error).message;
      await logSyncException({
        source: "payment_structure",
        title: "Could not update billing item",
        detail: message,
        metadata: { id },
      });
      return res.status(400).json({ error: message });
    }
  }

  if (req.method === "DELETE") {
    const id = typeof req.body?.id === "string" ? req.body.id : String(req.query.id ?? "");
    if (!id) return res.status(400).json({ error: "id required" });
    const hard = req.query.hard === "1";
    if (hard) {
      await prisma.billingItem.delete({ where: { id } });
    } else {
      await prisma.billingItem.update({ where: { id }, data: { active: false } });
    }
    return res.status(200).json({ ok: true });
  }

  res.setHeader("Allow", "GET, POST, PUT, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
