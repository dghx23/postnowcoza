import type { NextApiRequest, NextApiResponse } from "next";
import { serialize } from "cookie";
import { getSessionUser } from "@/lib/session";
import {
  clearDeviceTokens,
  EPSON_ACCESS_COOKIE,
  EPSON_REFRESH_COOKIE,
  EPSON_DEVICE_ID_COOKIE,
} from "@/lib/epson";

// Drop shared device tokens so staff can re-link a different printer.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await getSessionUser(req, res);
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return res.status(403).json({ error: "Forbidden" });
  }

  await clearDeviceTokens();

  const clear = { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/", maxAge: 0 };
  res.setHeader("Set-Cookie", [
    serialize(EPSON_ACCESS_COOKIE, "", clear),
    serialize(EPSON_REFRESH_COOKIE, "", clear),
    serialize(EPSON_DEVICE_ID_COOKIE, "", clear),
  ]);

  return res.status(200).json({ ok: true });
}
