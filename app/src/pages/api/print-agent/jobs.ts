import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@/lib/db";
import { isAuthorizedAgent } from "@/lib/printAgentAuth";

// Polled by the Linux print agent (see agent/linux-print-agent.py) - there's
// no equivalent to Epson's push-ish OAuth flow here, the agent just asks
// "what's pending?" on an interval, same pull model as Epson's own device
// polling but authenticated with a static token instead of a user session.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isAuthorizedAgent(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const jobs = await prisma.linuxPrintJob.findMany({
    where: { status: "PENDING" },
    include: { document: { select: { recipientName: true } } },
    orderBy: { createdAt: "asc" },
  });

  return res.status(200).json({
    jobs: jobs.map((j) => ({
      id: j.id,
      documentId: j.documentId,
      jobName: `postnow-${j.documentId}`,
      recipientName: j.document.recipientName,
      createdAt: j.createdAt,
    })),
  });
}
