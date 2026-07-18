import axios from "axios";

// Endpoints and payload shape below follow Epson Connect's documented OAuth +
// Print API flow, but this integration has never been run against a live
// Epson account or verified against their current OpenAPI spec — confirm
// against https://developer.epsonconnect.com/ before relying on it in
// production. Base URLs are env-overridable so a corrected value doesn't
// require a code change.
const AUTH_BASE = process.env.EPSON_AUTH_BASE_URL ?? "https://auth.epsonconnect.com";
const API_BASE = process.env.EPSON_API_BASE_URL ?? "https://api.epsonconnect.com/api/2";

const CLIENT_ID = process.env.EPSON_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.EPSON_CLIENT_SECRET ?? "";
const REDIRECT_URI = process.env.EPSON_REDIRECT_URI ?? "";
const API_KEY = process.env.EPSON_API_KEY;

export const EPSON_ACCESS_COOKIE = "epson_access_token";
export const EPSON_REFRESH_COOKIE = "epson_refresh_token";
const REFRESH_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

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
}

export function buildAuthorizeUrl(state?: string) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "printing",
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

export interface EpsonJob {
  status?: string;
  [key: string]: unknown;
}

export async function getJobs(accessToken: string): Promise<EpsonJob[]> {
  const res = await axios.get<{ jobs?: EpsonJob[] }>(`${API_BASE}/printing/jobs`, {
    headers: epsonHeaders(accessToken),
  });
  return res.data?.jobs ?? [];
}

// Prints a single PDF as one copy, A4, mono, duplex. Not parameterized
// further since the print queue only ever sends one kind of job today.
export async function printPdf(accessToken: string, pdfBuffer: Buffer, jobName: string) {
  return axios.post(
    `${API_BASE}/printing/print`,
    {
      job_name: jobName,
      print_settings: {
        media_size: "A4",
        color_mode: "mono",
        copies: 1,
        duplex: true,
      },
      file: {
        content_type: "application/pdf",
        name: `${jobName}.pdf`,
        data: pdfBuffer.toString("base64"),
      },
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...(API_KEY ? { "x-api-key": API_KEY } : {}),
      },
    }
  );
}
