import type { PrintProvider } from "@prisma/client";
import { prisma } from "@/lib/db";

// Singleton row - always id "singleton" (see schema.prisma). Upserted so
// the first read/write creates it rather than requiring a seed step.
export async function getPrintProvider(): Promise<PrintProvider> {
  const settings = await prisma.printSettings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
  });
  return settings.provider;
}

export async function setPrintProvider(provider: PrintProvider): Promise<PrintProvider> {
  const settings = await prisma.printSettings.upsert({
    where: { id: "singleton" },
    update: { provider },
    create: { id: "singleton", provider },
  });
  return settings.provider;
}
