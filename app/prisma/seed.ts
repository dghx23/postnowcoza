import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

// Creates the first staff account so someone can actually log into the
// facility dashboard - there's no signup flow yet, this is the bootstrap.
// Set SEED_STAFF_EMAIL/SEED_STAFF_PASSWORD before running; skips silently
// if unset so this is safe to leave in the default build pipeline.
async function main() {
  const email = process.env.SEED_STAFF_EMAIL;
  const password = process.env.SEED_STAFF_PASSWORD;
  if (!email || !password) {
    console.log("SEED_STAFF_EMAIL/SEED_STAFF_PASSWORD not set, skipping seed.");
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, passwordHash, role: "STAFF" },
  });
  console.log(`Staff user ready: ${user.email}`);

  const epsonDirectEmail = "postnow@print.epsonconnect.com";
  await prisma.printSettings.upsert({
    where: { id: "singleton" },
    update: { epsonDirectEmail },
    create: { id: "singleton", provider: "EPSON_DIRECT", epsonDirectEmail },
  });
  console.log(`Epson Direct email ready: ${epsonDirectEmail}`);

  // Staff roadmap tracker items — idempotent so every deploy keeps them present
  // without duplicating rows if someone already added them by hand.
  const roadmapItems: Array<{
    name: string;
    priority: "HIGH" | "MEDIUM" | "LOW";
    status: "NOT_STARTED" | "IN_PROGRESS" | "READY" | "IMPLEMENTED";
    comment: string;
  }> = [
    {
      name: "Grok Voice Agent",
      priority: "HIGH",
      status: "IN_PROGRESS",
      comment:
        "In-app voice assistant on /voice (xAI Grok Realtime). Read-only tools first: list documents, get status, live courier tracking, audit summary. Ephemeral client secrets keep XAI_API_KEY server-side. Next: customer actions (pay/return), staff ops tools, public marketing FAQ agent.",
    },
    {
      name: "Courier label maker (print-queue preview)",
      priority: "MEDIUM",
      status: "NOT_STARTED",
      comment:
        "Parked from Print Queue UI: shipping-label mock (PostNow / SECURE DISPATCH / deliver-to / tracking barcode) plus Instant Print flow diagram (PDF → Epson → PRINTED → history). Reintroduce when we generate real courier labels (Bob Go waybill) not just document PDF print.",
    },
    {
      name: "Customer portal (self-serve dispatch + pay)",
      priority: "HIGH",
      status: "NOT_STARTED",
      comment:
        "PARKED. Live app is staff ops. Reserved: /portal hub, /portal/dispatch/new (customer new dispatch → classic Pay dispatch fee self-serve), and /pay/[id] customer/guest mode (not staff request-payment email). Wire sidebar + auth for CUSTOMER when ready; staff keeps /dispatch/new → request payment by email.",
    },
  ];

  for (const item of roadmapItems) {
    const existing = await prisma.feature.findFirst({ where: { name: item.name } });
    if (!existing) {
      await prisma.feature.create({
        data: {
          name: item.name,
          priority: item.priority,
          status: item.status,
          comment: item.comment,
          createdBy: "seed",
        },
      });
      console.log(`Roadmap feature ready: ${item.name}`);
    } else {
      console.log(`Roadmap feature already present: ${item.name}`);
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
