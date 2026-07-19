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
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
