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

  // Staff roadmap tracker item — idempotent so every deploy keeps it present
  // without duplicating rows if someone already added it by hand.
  const voiceAgentName = "Grok Voice Agent";
  const existingVoice = await prisma.feature.findFirst({
    where: { name: voiceAgentName },
  });
  if (!existingVoice) {
    await prisma.feature.create({
      data: {
        name: voiceAgentName,
        priority: "HIGH",
        status: "IN_PROGRESS",
        comment:
          "In-app voice assistant on /voice (xAI Grok Realtime). Read-only tools first: list documents, get status, live courier tracking, audit summary. Ephemeral client secrets keep XAI_API_KEY server-side. Next: customer actions (pay/return), staff ops tools, public marketing FAQ agent.",
        createdBy: "seed",
      },
    });
    console.log(`Roadmap feature ready: ${voiceAgentName}`);
  } else {
    console.log(`Roadmap feature already present: ${voiceAgentName}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
