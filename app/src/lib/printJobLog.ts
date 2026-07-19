import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { appendAuditEvent } from "@/lib/audit";
import {
  labelColorMode,
  labelDoubleSided,
  labelPaperSize,
  labelPaperType,
  labelQuality,
  normalizeColorMode,
  normalizeCopies,
  type JobPrintSettings,
  type PrintColorMode,
} from "@/lib/printJobSettings";

export type PrintVia = "epson_connect" | "epson_direct" | "manual_mark";

export interface CustomerPrintRequest {
  colorMode: string;
  copies: number;
}

export interface PrintJobLogSnapshot {
  id: string;
  jobId: string;
  status: string;
  via: string | null;
  submittedById: string | null;
  customerColorMode: string | null;
  customerCopies: number | null;
  printedColorMode: string | null;
  printedCopies: number | null;
  printSettings: JobPrintSettings | null;
  outcomeDetail: Record<string, unknown> | null;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
  summary: string;
}

export function customerRequestFromDocument(doc: {
  printColorMode: string;
  printCopies: number;
}): CustomerPrintRequest {
  return {
    colorMode: normalizeColorMode(doc.printColorMode),
    copies: normalizeCopies(doc.printCopies),
  };
}

export function buildPrintJobSummary(input: {
  via: PrintVia | string | null;
  customer: CustomerPrintRequest | null;
  printed: Partial<JobPrintSettings> | null;
  status?: string | null;
}): string {
  const custColor = input.customer
    ? labelColorMode(normalizeColorMode(input.customer.colorMode))
    : "—";
  const custCopies = input.customer ? normalizeCopies(input.customer.copies) : "—";
  const printedColor = input.printed?.colorMode
    ? labelColorMode(normalizeColorMode(input.printed.colorMode))
    : "—";
  const printedCopies =
    input.printed?.copies != null ? normalizeCopies(input.printed.copies) : "—";

  const viaLabel =
    input.via === "epson_connect"
      ? "EpsonAPI"
      : input.via === "epson_direct"
        ? "EpsonMail"
        : input.via === "manual_mark"
          ? "Manual mark"
          : input.via ?? "Print";

  const parts = [
    viaLabel,
    `Customer: ${custColor} × ${custCopies}`,
    `Printed: ${printedColor} × ${printedCopies}`,
  ];
  if (input.printed?.paperSize) {
    parts.push(
      `${labelPaperSize(input.printed.paperSize)} / ${labelPaperType(input.printed.paperType ?? "pt_plainpaper")}`
    );
  }
  if (input.printed?.printQuality) {
    parts.push(labelQuality(input.printed.printQuality));
  }
  if (input.printed?.doubleSided) {
    parts.push(labelDoubleSided(input.printed.doubleSided));
  }
  if (input.status) parts.push(`status: ${input.status}`);
  return parts.join(" · ");
}

/**
 * Create EpsonPrintJob row + append print_job_submitted audit (customer + printed detail).
 */
export async function recordPrintJobSubmission(input: {
  documentId: string;
  jobId: string;
  via: PrintVia;
  actorId?: string;
  customer: CustomerPrintRequest;
  printed: JobPrintSettings;
  status?: string;
  extraMeta?: Record<string, unknown>;
  ip?: string;
}) {
  const status = input.status ?? "pending";
  const job = await prisma.epsonPrintJob.create({
    data: {
      documentId: input.documentId,
      jobId: input.jobId,
      status,
      via: input.via,
      submittedById: input.actorId ?? null,
      customerColorMode: normalizeColorMode(input.customer.colorMode),
      customerCopies: normalizeCopies(input.customer.copies),
      printedColorMode: normalizeColorMode(input.printed.colorMode),
      printedCopies: normalizeCopies(input.printed.copies),
      printSettings: input.printed as unknown as Prisma.InputJsonValue,
      confirmedAt: status === "completed" || status === "error_occurred" ? new Date() : null,
      outcomeDetail:
        status === "completed" || status === "error_occurred"
          ? ({
              via: input.via,
              ...(input.extraMeta ?? {}),
            } as Prisma.InputJsonValue)
          : undefined,
    },
  });

  const summary = buildPrintJobSummary({
    via: input.via,
    customer: input.customer,
    printed: input.printed,
    status,
  });

  const metadata = {
    via: input.via,
    jobId: input.jobId,
    summary,
    customerRequested: {
      colorMode: normalizeColorMode(input.customer.colorMode) as PrintColorMode,
      colorLabel: labelColorMode(normalizeColorMode(input.customer.colorMode)),
      copies: normalizeCopies(input.customer.copies),
    },
    printed: {
      colorMode: normalizeColorMode(input.printed.colorMode) as PrintColorMode,
      colorLabel: labelColorMode(normalizeColorMode(input.printed.colorMode)),
      copies: normalizeCopies(input.printed.copies),
      paperSize: input.printed.paperSize,
      paperSizeLabel: labelPaperSize(input.printed.paperSize),
      paperType: input.printed.paperType,
      paperTypeLabel: labelPaperType(input.printed.paperType),
      printQuality: input.printed.printQuality,
      printQualityLabel: labelQuality(input.printed.printQuality),
      paperSource: input.printed.paperSource,
      borderless: input.printed.borderless,
      doubleSided: input.printed.doubleSided,
      doubleSidedLabel: labelDoubleSided(input.printed.doubleSided),
    },
    mismatch: {
      color:
        normalizeColorMode(input.customer.colorMode) !==
        normalizeColorMode(input.printed.colorMode),
      copies:
        normalizeCopies(input.customer.copies) !== normalizeCopies(input.printed.copies),
    },
    ...input.extraMeta,
  };

  await appendAuditEvent({
    documentId: input.documentId,
    actorId: input.actorId,
    action: "print_job_submitted",
    metadata,
    ip: input.ip,
  });

  return { job, summary, metadata };
}

export function snapshotPrintJobs(
  jobs: Array<{
    id: string;
    jobId: string;
    status: string;
    via: string | null;
    submittedById: string | null;
    customerColorMode: string | null;
    customerCopies: number | null;
    printedColorMode: string | null;
    printedCopies: number | null;
    printSettings: unknown;
    outcomeDetail: unknown;
    confirmedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }>
): PrintJobLogSnapshot[] {
  return jobs.map((j) => {
    const settings =
      j.printSettings && typeof j.printSettings === "object"
        ? (j.printSettings as JobPrintSettings)
        : null;
    const customer =
      j.customerColorMode != null
        ? {
            colorMode: j.customerColorMode,
            copies: j.customerCopies ?? 1,
          }
        : null;
    const printed =
      settings ??
      (j.printedColorMode != null
        ? {
            colorMode: j.printedColorMode as PrintColorMode,
            copies: j.printedCopies ?? 1,
          }
        : null);

    return {
      id: j.id,
      jobId: j.jobId,
      status: j.status,
      via: j.via,
      submittedById: j.submittedById,
      customerColorMode: j.customerColorMode,
      customerCopies: j.customerCopies,
      printedColorMode: j.printedColorMode,
      printedCopies: j.printedCopies,
      printSettings: settings,
      outcomeDetail:
        j.outcomeDetail && typeof j.outcomeDetail === "object"
          ? (j.outcomeDetail as Record<string, unknown>)
          : null,
      confirmedAt: j.confirmedAt?.toISOString() ?? null,
      createdAt: j.createdAt.toISOString(),
      updatedAt: j.updatedAt.toISOString(),
      summary: buildPrintJobSummary({
        via: j.via,
        customer,
        printed,
        status: j.status,
      }),
    };
  });
}
