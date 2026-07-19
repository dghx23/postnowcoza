/** Shared helpers for Epson / Email Print outcome display. */

export type PrintOutcomeKind =
  | "completed"
  | "error_occurred"
  | "expired"
  | "canceled"
  | "pending"
  | "processing"
  | "preparing"
  | "reserved"
  | "submitted"
  | "unknown";

export interface PrintFeedbackDetail {
  status: PrintOutcomeKind | string;
  jobId: string | null;
  updatedAt: string | null;
  /** Human label for chips / table cells */
  label: string;
  tone: "success" | "navy" | "teal";
  /** Short hover / title text */
  summary: string;
  subject: string | null;
  snippet: string | null;
  from: string | null;
  via: string | null;
  outcome: string | null;
  source: "epson_connect" | "epson_direct" | "email_notification" | "epson_webhook" | "unknown";
}

export function printOutcomeLabel(status: string): {
  label: string;
  tone: "success" | "navy" | "teal";
} {
  switch (status) {
    case "completed":
      return { label: "Print successful", tone: "success" };
    case "error_occurred":
      return { label: "Print failed", tone: "navy" };
    case "expired":
      return { label: "Print expired", tone: "navy" };
    case "canceled":
      return { label: "Print canceled", tone: "navy" };
    case "pending":
    case "processing":
    case "preparing":
    case "reserved":
      return { label: "Awaiting printer confirmation", tone: "teal" };
    case "submitted":
      return { label: "Sent to printer", tone: "teal" };
    default:
      return { label: status.replace(/_/g, " "), tone: "navy" };
  }
}

export function isFailureStatus(status: string): boolean {
  return status === "error_occurred" || status === "expired" || status === "canceled";
}

export function isPendingStatus(status: string): boolean {
  return (
    status === "pending" ||
    status === "processing" ||
    status === "preparing" ||
    status === "reserved" ||
    status === "submitted"
  );
}

function metaString(meta: unknown, key: string): string | null {
  if (!meta || typeof meta !== "object") return null;
  const v = (meta as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() ? v : null;
}

export function buildPrintFeedback(input: {
  jobStatus?: string | null;
  jobId?: string | null;
  jobUpdatedAt?: Date | string | null;
  /** Latest relevant audit event action */
  auditAction?: string | null;
  auditMetadata?: unknown;
  auditAt?: Date | string | null;
  /** Document workflow status — used when no job row exists yet */
  documentStatus?: string | null;
}): PrintFeedbackDetail | null {
  const jobStatus = input.jobStatus ?? null;
  const auditAction = input.auditAction ?? null;

  let status: string | null = jobStatus;

  if (!status && auditAction === "epson_print_confirmed") status = "completed";
  if (!status && (auditAction === "epson_print_failed" || auditAction === "email_print_failed")) {
    status = metaString(input.auditMetadata, "outcome") ?? "error_occurred";
  }
  if (!status && input.documentStatus === "PRINTED") status = "submitted";
  if (!status) return null;

  const { label, tone } = printOutcomeLabel(status);
  const subject = metaString(input.auditMetadata, "subject");
  const snippet = metaString(input.auditMetadata, "snippet");
  const from = metaString(input.auditMetadata, "from");
  const via = metaString(input.auditMetadata, "via");
  const outcome = metaString(input.auditMetadata, "outcome");

  let source: PrintFeedbackDetail["source"] = "unknown";
  if (via === "email_notification") source = "email_notification";
  else if (via === "epson_connect_webhook") source = "epson_webhook";
  else if (via === "epson_direct") source = "epson_direct";
  else if (via === "epson_connect") source = "epson_connect";
  else if (input.jobId?.startsWith("email-print:") || input.jobId?.startsWith("email-notify:")) {
    source = "epson_direct";
  } else if (input.jobId) {
    source = "epson_connect";
  }

  const updatedAt =
    (input.jobUpdatedAt
      ? new Date(input.jobUpdatedAt).toISOString()
      : null) ||
    (input.auditAt ? new Date(input.auditAt).toISOString() : null);

  const summaryParts = [label];
  if (subject) summaryParts.push(subject);
  else if (snippet) summaryParts.push(snippet.slice(0, 120));

  return {
    status,
    jobId: input.jobId ?? metaString(input.auditMetadata, "jobId"),
    updatedAt,
    label,
    tone,
    summary: summaryParts.join(" — "),
    subject,
    snippet,
    from,
    via,
    outcome,
    source,
  };
}

export function sourceLabel(source: PrintFeedbackDetail["source"]): string {
  switch (source) {
    case "email_notification":
      return "Epson email";
    case "epson_webhook":
      return "Epson Connect webhook";
    case "epson_direct":
      return "Email Print";
    case "epson_connect":
      return "Epson Connect API";
    default:
      return "Printer";
  }
}
