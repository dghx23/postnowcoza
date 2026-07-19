import axios from "axios";
import { prisma } from "@/lib/db";

// Epson Connect API v2 — verified against Epson's official tutorial
// (developer.epsonconnect.com/Portals/tutorial) and OpenAPI shape.
//
// Auth (this was the invalid_client root cause):
//   Token endpoint REQUIRES HTTP Basic auth with client_id:client_secret.
//   Body must NOT put client_secret in the form for authorization_code /
//   refresh_token (Basic carries credentials). Putting secret only in the
//   body is what Epson rejects with invalid_client.
//
// Print flow:
//   POST /printing/jobs         -> { jobId, uploadUri }
//   POST <uploadUri>&File=1.pdf (raw PDF bytes on upload.epsonconnect.com)
//   POST /printing/jobs/{jobId}/print
//
// Device token is already scoped to one printer — no device ID in paths.
// Token response does not include subject_id.
//
// v1 (/api/1/) was discontinued 2026-04-01; this uses v2 (/api/2/).
const AUTH_BASE = (process.env.EPSON_AUTH_BASE_URL || "https://auth.epsonconnect.com").trim();
const API_BASE = (process.env.EPSON_API_BASE_URL || "https://api.epsonconnect.com/api/2").trim();

// Trim — stray paste whitespace has corrupted other secrets (R2, Courier Guy).
function envTrim(name: string): string {
  return (process.env[name] ?? "").trim();
}

function getClientId() {
  return envTrim("EPSON_CLIENT_ID");
}
function getClientSecret() {
  return envTrim("EPSON_CLIENT_SECRET");
}
function getRedirectUri() {
  return envTrim("EPSON_REDIRECT_URI");
}
function getApiKey() {
  return envTrim("EPSON_API_KEY");
}

export const EPSON_ACCESS_COOKIE = "epson_access_token";
export const EPSON_REFRESH_COOKIE = "epson_refresh_token";
export const EPSON_DEVICE_ID_COOKIE = "epson_device_id";
const REFRESH_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

/** Refresh a few minutes early so mid-request expiry is rare. */
const ACCESS_SKEW_MS = 5 * 60 * 1000;

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
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  /** Present on some older flows; not returned by official OAuth tutorial response. */
  subject_id?: string;
}

/** HTTP Basic (client_id:client_secret) — required by Epson token endpoint. */
function basicAuthHeader(): string {
  const id = getClientId();
  const secret = getClientSecret();
  return `Basic ${Buffer.from(`${id}:${secret}`, "utf8").toString("base64")}`;
}

export function epsonCredentialsConfigured(): boolean {
  return Boolean(getClientId() && getClientSecret() && getRedirectUri() && getApiKey());
}

export function describeCredentialHealth() {
  const clientId = getClientId();
  const clientSecret = getClientSecret();
  const redirectUri = getRedirectUri();
  const apiKey = getApiKey();
  const rawId = process.env.EPSON_CLIENT_ID ?? "";
  const rawSecret = process.env.EPSON_CLIENT_SECRET ?? "";
  return {
    clientIdLength: clientId.length,
    clientIdHasWhitespace: rawId !== rawId.trim(),
    clientSecretLength: clientSecret.length,
    clientSecretHasWhitespace: rawSecret !== rawSecret.trim(),
    redirectUri,
    apiKeyLength: apiKey.length,
    apiKeyConfigured: Boolean(apiKey),
  };
}

// scope=device authorizes a specific printer selected by the user.
export function buildAuthorizeUrl(state?: string) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: getClientId(),
    redirect_uri: getRedirectUri(),
    scope: "device",
  });
  if (state) params.set("state", state);
  return `${AUTH_BASE}/auth/authorize?${params.toString()}`;
}

/**
 * Exchange authorization code for device tokens.
 * Official shape: Authorization Basic + body grant_type/code/redirect_uri/client_id
 * (no client_secret in body — that is what caused invalid_client).
 */
export async function exchangeCodeForTokens(code: string): Promise<EpsonTokens> {
  if (!getClientId() || !getClientSecret() || !getRedirectUri()) {
    throw new Error("Epson OAuth credentials are not fully configured (CLIENT_ID/SECRET/REDIRECT_URI)");
  }

  const res = await axios.post<EpsonTokens>(
    `${AUTH_BASE}/auth/token`,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: getRedirectUri(),
      client_id: getClientId(),
    }),
    {
      headers: {
        Authorization: basicAuthHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );
  return res.data;
}

/**
 * Refresh device access token.
 * Official shape: Authorization Basic + body grant_type/refresh_token only.
 */
export async function refreshTokens(refreshToken: string): Promise<EpsonTokens> {
  if (!getClientId() || !getClientSecret()) {
    throw new Error("Epson OAuth credentials are not fully configured (CLIENT_ID/SECRET)");
  }

  const res = await axios.post<EpsonTokens>(
    `${AUTH_BASE}/auth/token`,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    {
      headers: {
        Authorization: basicAuthHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );
  return res.data;
}

/**
 * App-level token (client_credentials) for APIs that don't touch a device
 * (e.g. notification settings). Scope per Epson tutorial: device.
 */
export async function getAppToken(): Promise<string> {
  const res = await axios.post<EpsonTokens>(
    `${AUTH_BASE}/auth/token`,
    new URLSearchParams({
      grant_type: "client_credentials",
      scope: "device",
    }),
    {
      headers: {
        Authorization: basicAuthHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );
  return res.data.access_token;
}

// ── Durable token storage (PrintSettings singleton) ─────────────────────────
// Cookies alone break multi-staff / multi-browser and serverless refresh.
// We still set cookies on OAuth callback for backwards compatibility, but
// the source of truth is the database.

export async function saveDeviceTokens(tokens: EpsonTokens): Promise<void> {
  const expiresAt = new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000);
  await prisma.printSettings.upsert({
    where: { id: "singleton" },
    update: {
      epsonAccessToken: tokens.access_token,
      epsonRefreshToken: tokens.refresh_token ?? undefined,
      epsonTokenExpiresAt: expiresAt,
    },
    create: {
      id: "singleton",
      epsonAccessToken: tokens.access_token,
      epsonRefreshToken: tokens.refresh_token ?? null,
      epsonTokenExpiresAt: expiresAt,
    },
  });
}

export async function clearDeviceTokens(): Promise<void> {
  await prisma.printSettings.upsert({
    where: { id: "singleton" },
    update: {
      epsonAccessToken: null,
      epsonRefreshToken: null,
      epsonTokenExpiresAt: null,
    },
    create: { id: "singleton" },
  });
}

export interface DeviceSession {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  /** True when tokens came from DB (shared) vs request cookies only. */
  fromDb: boolean;
}

/**
 * Resolve a usable device access token: DB first, then optional cookie
 * fallback. Refreshes when expired / near expiry and persists the new pair.
 */
export async function getValidDeviceSession(cookieFallback?: {
  accessToken?: string;
  refreshToken?: string;
}): Promise<DeviceSession | null> {
  const row = await prisma.printSettings.findUnique({ where: { id: "singleton" } });

  let accessToken = row?.epsonAccessToken ?? cookieFallback?.accessToken ?? null;
  let refreshToken = row?.epsonRefreshToken ?? cookieFallback?.refreshToken ?? null;
  let expiresAt = row?.epsonTokenExpiresAt ?? null;
  const fromDb = Boolean(row?.epsonAccessToken || row?.epsonRefreshToken);

  if (!accessToken && !refreshToken) return null;

  const needsRefresh =
    !accessToken ||
    !expiresAt ||
    expiresAt.getTime() <= Date.now() + ACCESS_SKEW_MS;

  if (needsRefresh && refreshToken) {
    try {
      const refreshed = await refreshTokens(refreshToken);
      await saveDeviceTokens({
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token ?? refreshToken,
        expires_in: refreshed.expires_in,
      });
      return {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token ?? refreshToken,
        expiresAt: new Date(Date.now() + (refreshed.expires_in ?? 3600) * 1000),
        fromDb: true,
      };
    } catch (err) {
      console.error("Epson device token refresh failed", {
        message: (err as Error).message,
        status: axios.isAxiosError(err) ? err.response?.status : undefined,
        data: axios.isAxiosError(err) ? err.response?.data : undefined,
        ...describeCredentialHealth(),
      });
      // Stale tokens — clear so UI shows not_connected instead of looping 401s.
      if (fromDb) await clearDeviceTokens();
      return null;
    }
  }

  if (!accessToken) return null;

  return {
    accessToken,
    refreshToken,
    expiresAt,
    fromDb,
  };
}

// Both headers required on every printing/* call (deviceToken + apiKey).
function epsonHeaders(accessToken: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "x-api-key": getApiKey(),
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

export async function getJobStatus(accessToken: string, jobId: string): Promise<EpsonJob> {
  const res = await axios.get<EpsonJob>(`${API_BASE}/printing/jobs/${jobId}`, {
    headers: epsonHeaders(accessToken),
  });
  return res.data;
}

export interface EpsonPrintSettings {
  paperSize?: string;
  paperType?: string;
  borderless?: boolean;
  printQuality?: string;
  paperSource?: string;
  colorMode?: string;
  doubleSided?: string;
  reverseOrder?: boolean;
  copies?: number;
  collate?: boolean;
}

export async function getDefaultPrintSettings(accessToken: string): Promise<{ printSettings: EpsonPrintSettings }> {
  const res = await axios.get<{ printSettings: EpsonPrintSettings }>(`${API_BASE}/printing/capability/default`, {
    headers: epsonHeaders(accessToken),
  });
  return res.data;
}

export interface EpsonPaperTypeCapability {
  paperType: string;
  borderless: boolean;
  paperSources: string[];
  printQualities: string[];
  doubleSided: boolean;
}

export interface EpsonPrintCapability {
  colorModes: string[];
  resolutions: number[];
  paperSizes: Array<{ paperSize: string; paperTypes: EpsonPaperTypeCapability[] }>;
}

export async function getPrintCapability(
  accessToken: string,
  printMode: "document" | "photo"
): Promise<EpsonPrintCapability> {
  const res = await axios.get<EpsonPrintCapability>(`${API_BASE}/printing/capability/${printMode}`, {
    headers: epsonHeaders(accessToken),
  });
  return res.data;
}

export interface EpsonNotificationSettings {
  notification: boolean;
  callbackUri?: string;
}

/** Notification APIs use app token (client_credentials), not device token. */
export async function getNotificationSettings(): Promise<EpsonNotificationSettings> {
  const appToken = await getAppToken();
  const res = await axios.get<EpsonNotificationSettings>(`${API_BASE}/printing/settings/notification`, {
    headers: epsonHeaders(appToken),
  });
  return res.data;
}

interface CreateJobResponse {
  jobId: string;
  uploadUri: string;
}

// Settings match Epson's tutorial sample (no duplex — many devices report
// doubleSided:false for plain A4 and reject "long").
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
        copies: 1,
      },
    },
    { headers: { ...epsonHeaders(accessToken), "Content-Type": "application/json" } }
  );

  const { jobId, uploadUri } = createRes.data;

  const separator = uploadUri.includes("?") ? "&" : "?";
  await axios.post(`${uploadUri}${separator}File=1.pdf`, pdfBuffer, {
    headers: {
      "Content-Length": pdfBuffer.length,
      "Content-Type": "application/pdf",
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  await axios.post(`${API_BASE}/printing/jobs/${jobId}/print`, undefined, {
    headers: epsonHeaders(accessToken),
  });

  return jobId;
}
