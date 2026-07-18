import type { NextApiRequest } from "next";

const AGENT_TOKEN = process.env.PRINT_AGENT_TOKEN ?? "";

// The Linux print agent is an unattended script with no browser session,
// so it can't use getSessionUser() like every other route - it presents a
// static bearer token instead, generated once and placed in both Vercel's
// env vars and the agent's own config file.
export function isAuthorizedAgent(req: NextApiRequest): boolean {
  if (!AGENT_TOKEN) return false;
  const header = req.headers.authorization ?? "";
  const [scheme, token] = header.split(" ");
  return scheme === "Bearer" && token === AGENT_TOKEN;
}
