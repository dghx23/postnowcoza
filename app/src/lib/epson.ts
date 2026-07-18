import axios from "axios";

// Verified directly against Epson's official OpenAPI v2 spec (user-supplied
// document, 2026-07-18) - this replaces an earlier "web search verified"
// version that still had the print-job path/body/headers wrong. Key facts
// confirmed straight from the spec:
//   - Job creation/print/lookup have NO device ID in the path at all - the
//     device token itself is already scoped to exactly one printer.
//   - POST /printing/jobs         -> { jobId, uploadUri }   (uploadUri is a
//     full URL on a *different* host, upload.epsonconnect.com, already
//     carrying a `Key` query param - we only need to add `&File=`)
//   - POST /printing/jobs/{jobId}/print   starts the print, no body
//   - GET  /printing/jobs/{jobId}         is the ONLY job-lookup endpoint -
//     there is no "list all jobs" endpoint, so pending-job tracking has to
//     be done by polling job IDs we recorded ourselves (see EpsonPrintJob).
//   - Every call requires BOTH `Authorization: Bearer <device token>` AND
//     `x-api-key: <key>` headers together (per the spec's own code samples),
//     not Bearer alone.
// Epson Connect API v1 ("/api/1/") was discontinued 2026-04-01; this uses
// v2 ("/api/2/") throughout.
const AUTH_BASE = process.env.EPSON_AUTH_BASE_URL ?? "https://auth.epsonconnect.com";
const API_BASE = process.env.EPSON_API_BASE_URL ?? "https://api.epsonconnect.com/api/2";

const CLIENT_ID = process.env.EPSON_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.EPSON_CLIENT_SECRET ?? "";
const REDIRECT_URI = process.env.EPSON_REDIRECT_URI ?? "";
const API_KEY = process.env.EPSON_API_KEY ?? "";

export const EPSON_ACCESS_COOKIE = "epson_access_token";
export const EPSON_REFRESH_COOKIE = "epson_refresh_token";
export const EPSON_DEVICE_ID_COOKIE = "epson_device_id";
const REFRESH_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days - matches the refresh token's own lifetime

export function epsonCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

export function epsonRefreshCookieOptions() {
  return epsonCookieOptions(REFRESH_COOKIE_MAX_AGE);
}

export interface EpsonTokens {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  // The device ID for the authorized printer, returned as `subject_id` on
  // the token response (not a separate lookup call).
  subject_id?: string;
}

// scope=device is what authorizes access to a specific printer/scanner -
// "printing" (used in the original guess) isn't a documented scope.
export function buildAuthorizeUrl(state?: string) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "device",
  });
  if (state) params.set("state", state);
  return `${AUTH_BASE}/auth/authorize?${params.toString()}`;
}

export async function exchangeCodeForTokens(code: string): Promise<EpsonTokens> {
  const res = await axios.post<EpsonTokens>(
    `${AUTH_BASE}/auth/token`,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  return res.data;
}

export async function refreshTokens(refreshToken: string): Promise<EpsonTokens> {
  const res = await axios.post<EpsonTokens>(
    `${AUTH_BASE}/auth/token`,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  return res.data;
}

// Both headers are required together on every printing/* call per the
// spec's securitySchemes (deviceToken + apiKey) - x-api-key is not optional.
function epsonHeaders(accessToken: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "x-api-key": API_KEY,
  };
}

export interface EpsonDeviceInfo {
  connected?: boolean;
  productName?: string;
  serialNumber?: string;
  [key: string]: unknown;
}

export async function getDeviceInfo(accessToken: string): Promise<EpsonDeviceInfo> {
  const res = await axios.get<EpsonDeviceInfo>(`${API_BASE}/printing/devices/info`, {
    headers: epsonHeaders(accessToken),
  });
  return res.data;
}

// Epson's job status enum, straight from the spec - "pending"/"processing"
// (among others) are what count as still-in-flight for our pending-jobs UI.
export type EpsonJobStatus =
  | "preparing"
  | "reserved"
  | "pending"
  | "processing"
  | "media_empty"
  | "media_jam"
  | "marker_supply_empty"
  | "stopped_other"
  | "canceled"
  | "error_occurred"
  | "completed"
  | "expired";

export interface EpsonJob {
  status: EpsonJobStatus;
  jobName?: string;
  totalPages?: number;
  startDate?: string;
  updateDate?: string;
}

// There is no "list all jobs" endpoint in the Epson API - only lookup by ID.
// Callers must track job IDs themselves (see EpsonPrintJob in the schema)
// and poll each one through this.
export async function getJobStatus(accessToken: string, jobId: string): Promise<EpsonJob> {
  const res = await axios.get<EpsonJob>(`${API_BASE}/printing/jobs/${jobId}`, {
    headers: epsonHeaders(accessToken),
  });
  return res.data;
}

interface CreateJobResponse {
  jobId: string;
  uploadUri: string;
}

// Prints a single PDF, one copy, A4, mono. Not parameterized further since
// the print queue only ever sends one kind of job today. Field names and
// enum values (ps_a4/pt_plainpaper/etc.) are camelCase per the spec, not the
// snake_case previously guessed.
export async function printPdf(accessToken: string, pdfBuffer: Buffer, jobName: string): Promise<string> {
  const createRes = await axios.post<CreateJobResponse>(
    `${API_BASE}/printing/jobs`,
    {
      jobName,
      printMode: "document",
      printSettings: {
        paperSize: "ps_a4",
        paperType: "pt_plainpaper",
        borderless: false,
        printQuality: "normal",
        paperSource: "auto",
        colorMode: "mono",
        doubleSided: "long",
        copies: 1,
        collate: true,
      },
    },
    { headers: { ...epsonHeaders(accessToken), "Content-Type": "application/json" } }
  );

  const { jobId, uploadUri } = createRes.data;

  // uploadUri already carries `?Key=...` - the /data endpoint also requires
  // a `File` query param naming the extension being uploaded.
  const separator = uploadUri.includes("?") ? "&" : "?";
  await axios.post(`${uploadUri}${separator}File=1.pdf`, pdfBuffer, {
    headers: {
      "Content-Length": pdfBuffer.length,
      "Content-Type": "application/pdf",
    },
  });

  await axios.post(`${API_BASE}/printing/jobs/${jobId}/print`, undefined, {
    headers: epsonHeaders(accessToken),
  });

  return jobId;
}
