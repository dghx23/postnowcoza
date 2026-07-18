import axios from "axios";

// Verified against Epson's actual public docs/spec (docs.epsonconnect.com,
// EpsonConnectAPI_Specification, third-party SDKs) via web search on
// 2026-07-18 - Epson's own developer portal blocks automated fetches, so
// this was pieced together from search-engine-indexed content rather than
// read directly. Still worth a final check against a live account before
// fully trusting it, but this replaces an earlier version that was pure
// guesswork (wrong scope, wrong print flow shape, wrong field names).
//
// Print flow is three calls, not one:
//   1. POST  {API_BASE}/printing/printers/{deviceId}/jobs        -> { id, upload_uri }
//   2. POST  {upload_uri}                                        (raw file bytes)
//   3. POST  {API_BASE}/printing/printers/{deviceId}/jobs/{id}/print
//
// Epson Connect API v1 ("/api/1/") was discontinued 2026-04-01; this uses
// v2 ("/api/2/") throughout.
const AUTH_BASE = process.env.EPSON_AUTH_BASE_URL ?? "https://auth.epsonconnect.com";
const API_BASE = process.env.EPSON_API_BASE_URL ?? "https://api.epsonconnect.com/api/2";

const CLIENT_ID = process.env.EPSON_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.EPSON_CLIENT_SECRET ?? "";
const REDIRECT_URI = process.env.EPSON_REDIRECT_URI ?? "";
const API_KEY = process.env.EPSON_API_KEY;

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

function epsonHeaders(accessToken: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    ...(API_KEY ? { "x-api-key": API_KEY } : {}),
  };
}

// Device info/job-listing endpoint shapes below are a best-effort
// reconstruction from the same conventions as the verified job-creation
// endpoint (/printing/printers/{deviceId}/...) - unlike the print flow
// itself, these two weren't directly confirmed by a source, so treat their
// response shape as a guess until checked against a live account.
export interface EpsonDeviceInfo {
  connected?: boolean;
  productName?: string;
  serialNumber?: string;
  [key: string]: unknown;
}

export async function getDeviceInfo(accessToken: string, deviceId: string): Promise<EpsonDeviceInfo> {
  const res = await axios.get<EpsonDeviceInfo>(`${API_BASE}/printing/printers/${deviceId}`, {
    headers: epsonHeaders(accessToken),
  });
  return res.data;
}

export interface EpsonJob {
  status?: string;
  [key: string]: unknown;
}

export async function getJobs(accessToken: string, deviceId: string): Promise<EpsonJob[]> {
  const res = await axios.get<{ jobs?: EpsonJob[] }>(`${API_BASE}/printing/printers/${deviceId}/jobs`, {
    headers: epsonHeaders(accessToken),
  });
  return res.data?.jobs ?? [];
}

// Prints a single PDF, one copy, A4, mono, duplex (long-edge). Three
// sequential calls per the verified flow above - not parameterized further
// since the print queue only ever sends one kind of job today.
export async function printPdf(accessToken: string, deviceId: string, pdfBuffer: Buffer, jobName: string) {
  const createRes = await axios.post<{ id: string; upload_uri: string }>(
    `${API_BASE}/printing/printers/${deviceId}/jobs`,
    {
      job_name: jobName,
      print_mode: "document",
      print_setting: {
        media_size: "ms_a4",
        media_type: "mt_plainpaper",
        borderless: false,
        print_quality: "normal",
        source: "auto",
        color_mode: "mono",
        two_sided: "long",
        reverse_order: false,
        copies: 1,
        collate: true,
      },
    },
    { headers: { ...epsonHeaders(accessToken), "Content-Type": "application/json" } }
  );

  const { id: jobId, upload_uri: uploadUri } = createRes.data;

  await axios.post(uploadUri, pdfBuffer, {
    headers: {
      "Content-Length": pdfBuffer.length,
      "Content-Type": "application/pdf",
    },
  });

  return axios.post(
    `${API_BASE}/printing/printers/${deviceId}/jobs/${jobId}/print`,
    {},
    { headers: epsonHeaders(accessToken) }
  );
}
