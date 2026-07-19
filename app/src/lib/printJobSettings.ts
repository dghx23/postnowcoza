/**
 * Epson Connect job settings used for Print EpsonAPI.
 * Customer chooses colorMode + copies at dispatch; facility defaults
 * (and staff dialog overrides) supply the rest.
 */

export type PrintColorMode = "mono" | "color";

export interface JobPrintSettings {
  paperSize: string;
  paperType: string;
  printQuality: string;
  paperSource: string;
  borderless: boolean;
  doubleSided: string;
  colorMode: PrintColorMode;
  copies: number;
}

export const PAPER_SIZES = [
  { value: "ps_a4", label: "A4" },
  { value: "ps_letter", label: "Letter" },
  { value: "ps_a5", label: "A5" },
  { value: "ps_a6", label: "A6" },
  { value: "ps_legal", label: "Legal" },
  { value: "ps_b5", label: "B5" },
] as const;

export const PAPER_TYPES = [
  { value: "pt_plainpaper", label: "Plain paper" },
  { value: "pt_photopaper", label: "Photo paper" },
] as const;

export const PRINT_QUALITIES = [
  { value: "draft", label: "Draft" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
] as const;

export const PAPER_SOURCES = [
  { value: "rear", label: "Rear" },
  { value: "auto", label: "Auto" },
] as const;

export const DOUBLE_SIDED = [
  { value: "none", label: "Single-sided" },
  { value: "long", label: "Duplex (long edge)" },
  { value: "short", label: "Duplex (short edge)" },
] as const;

export function normalizeColorMode(raw: unknown): PrintColorMode {
  return raw === "color" ? "color" : "mono";
}

export function normalizeCopies(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.min(10, Math.max(1, Math.round(n)));
}

export function labelColorMode(mode: PrintColorMode): string {
  return mode === "color" ? "Colour" : "Black & white";
}

export function labelPaperSize(value: string): string {
  return PAPER_SIZES.find((p) => p.value === value)?.label ?? value;
}

export function labelPaperType(value: string): string {
  return PAPER_TYPES.find((p) => p.value === value)?.label ?? value;
}

export function labelQuality(value: string): string {
  return PRINT_QUALITIES.find((p) => p.value === value)?.label ?? value;
}

export function labelDoubleSided(value: string): string {
  return DOUBLE_SIDED.find((p) => p.value === value)?.label ?? value;
}

/** Build job settings: facility defaults + customer prefs + staff overrides. */
export function resolveJobPrintSettings(input: {
  facility: {
    printPaperSize: string;
    printPaperType: string;
    printQuality: string;
    printPaperSource: string;
    printBorderless: boolean;
    printDoubleSided: string;
  };
  customer: {
    printColorMode: string;
    printCopies: number;
  };
  override?: Partial<JobPrintSettings> | null;
}): JobPrintSettings {
  const base: JobPrintSettings = {
    paperSize: input.facility.printPaperSize || "ps_a4",
    paperType: input.facility.printPaperType || "pt_plainpaper",
    printQuality: input.facility.printQuality || "normal",
    paperSource: input.facility.printPaperSource || "rear",
    borderless: Boolean(input.facility.printBorderless),
    doubleSided: input.facility.printDoubleSided || "none",
    colorMode: normalizeColorMode(input.customer.printColorMode),
    copies: normalizeCopies(input.customer.printCopies),
  };
  if (!input.override) return base;
  return {
    ...base,
    ...input.override,
    colorMode: normalizeColorMode(input.override.colorMode ?? base.colorMode),
    copies: normalizeCopies(input.override.copies ?? base.copies),
    borderless:
      input.override.borderless !== undefined ? Boolean(input.override.borderless) : base.borderless,
  };
}

/** Body for Epson POST /printing/jobs printSettings. Omit duplex when none. */
export function toEpsonPrintSettingsBody(s: JobPrintSettings): Record<string, unknown> {
  const body: Record<string, unknown> = {
    paperSize: s.paperSize,
    paperType: s.paperType,
    borderless: s.borderless,
    printQuality: s.printQuality,
    paperSource: s.paperSource,
    colorMode: s.colorMode,
    copies: s.copies,
  };
  // L3251 capability often has doubleSided:false — only send when not "none".
  if (s.doubleSided && s.doubleSided !== "none") {
    body.doubleSided = s.doubleSided;
  }
  return body;
}
