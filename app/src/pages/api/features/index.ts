import type { NextApiRequest, NextApiResponse } from "next";
import type { FeaturePriority, FeatureStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

// Sorting priority by the DB column directly ('HIGH' < 'LOW' < 'MEDIUM'
// alphabetically) wouldn't give high-to-low order - rank map + client-side
// sort instead.
const PRIORITY_RANK: Record<FeaturePriority, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const user = await getSessionUser(req, res);
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return res.status(403).json({ error: "Forbidden" });
  }

  if (req.method === "GET") {
    const features = await prisma.feature.findMany({ orderBy: { createdAt: "desc" } });
    features.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
    return res.status(200).json(features);
  }

  if (req.method === "POST") {
    const { name, priority, status, comment } = req.body as {
      name?: string;
      priority?: FeaturePriority;
      status?: FeatureStatus;
      comment?: string;
    };
    if (!name?.trim()) {
      return res.status(400).json({ error: "Feature name is required" });
    }

    const feature = await prisma.feature.create({
      data: {
        name: name.trim(),
        priority: priority ?? "MEDIUM",
        status: status ?? "NOT_STARTED",
        comment: comment || null,
        createdBy: user.email,
      },
    });
    return res.status(201).json(feature);
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Method not allowed" });
}
