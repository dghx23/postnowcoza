import type { PrintProvider } from "@prisma/client";
import { prisma } from "@/lib/db";

export interface PrintSettingsValue {
  provider: PrintProvider;
  epsonDirectEmail: string | null;
}

// Singleton row - always id "singleton" (see schema.prisma). Upserted so
// the first read/write creates it rather than requiring a seed step.
export async function getPrintSettings(): Promise<PrintSettingsValue> {
  const settings = await prisma.printSettings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
  });
  return { provider: settings.provider, epsonDirectEmail: settings.epsonDirectEmail };
}

export async function updatePrintSettings(input: {
  provider?: PrintProvider;
  epsonDirectEmail?: string | null;
}): Promise<PrintSettingsValue> {
  const settings = await prisma.printSettings.upsert({
    where: { id: "singleton" },
    update: input,
    create: { id: "singleton", ...input },
  });
  return { provider: settings.provider, epsonDirectEmail: settings.epsonDirectEmail };
}
