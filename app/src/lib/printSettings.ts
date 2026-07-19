import type { PrintProvider } from "@prisma/client";
import { prisma } from "@/lib/db";

export interface PrintSettingsValue {
  provider: PrintProvider;
  epsonDirectEmail: string | null;
  printPaperSize: string;
  printPaperType: string;
  printQuality: string;
  printPaperSource: string;
  printBorderless: boolean;
  printDoubleSided: string;
}

function mapRow(settings: {
  provider: PrintProvider;
  epsonDirectEmail: string | null;
  printPaperSize: string;
  printPaperType: string;
  printQuality: string;
  printPaperSource: string;
  printBorderless: boolean;
  printDoubleSided: string;
}): PrintSettingsValue {
  return {
    provider: settings.provider,
    epsonDirectEmail: settings.epsonDirectEmail,
    printPaperSize: settings.printPaperSize,
    printPaperType: settings.printPaperType,
    printQuality: settings.printQuality,
    printPaperSource: settings.printPaperSource,
    printBorderless: settings.printBorderless,
    printDoubleSided: settings.printDoubleSided,
  };
}

// Singleton row - always id "singleton" (see schema.prisma).
export async function getPrintSettings(): Promise<PrintSettingsValue> {
  const settings = await prisma.printSettings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
  });
  return mapRow(settings);
}

export async function updatePrintSettings(input: {
  provider?: PrintProvider;
  epsonDirectEmail?: string | null;
  printPaperSize?: string;
  printPaperType?: string;
  printQuality?: string;
  printPaperSource?: string;
  printBorderless?: boolean;
  printDoubleSided?: string;
}): Promise<PrintSettingsValue> {
  const settings = await prisma.printSettings.upsert({
    where: { id: "singleton" },
    update: input,
    create: { id: "singleton", ...input },
  });
  return mapRow(settings);
}
