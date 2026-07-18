import type { NextApiRequest, NextApiResponse } from "next";
import type { FeaturePriority, FeatureStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await getSessionUser(req, res);
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { id } = req.query;
  if (typeof id !== "string") return res.status(400).json({ error: "Missing id" });

  const existing = await prisma.feature.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: "Feature not found" });

  if (req.method === "PATCH") {
    const { status, comment, checked, priority } = req.body as {
      status?: FeatureStatus;
      comment?: string | null;
      checked?: boolean;
      priority?: FeaturePriority;
    };

    const updated = await prisma.feature.update({
      where: { id },
      data: {
        ...(status && { status }),
        ...(comment !== undefined && { comment }),
        ...(checked !== undefined && { checked }),
        ...(priority && { priority }),
      },
    });
    return res.status(200).json(updated);
  }

  if (req.method === "DELETE") {
    await prisma.feature.delete({ where: { id } });
    return res.status(204).end();
  }

  res.setHeader("Allow", "PATCH, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}
