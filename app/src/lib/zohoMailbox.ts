import tls from "tls";
import { simpleParser } from "mailparser";

/**
 * Low-level access to the Zoho print-agent mailbox (IMAP preferred, POP3
 * fallback). Credentials are shared with SMTP Email Print unless overridden.
 *
 * Zoho notes:
 * - Org host: imappro.zoho.com / poppro.zoho.com
 * - IMAP must be enabled per mailbox (Settings → Mail Accounts → IMAP)
 * - Org email policy can allow SMTP while blocking IMAP/POP
 * - With TFA / SAML, use an Application-Specific Password for IMAP/POP
 */

const IMAP_HOST = (process.env.IMAP_HOST ?? "imappro.zoho.com").trim();
const IMAP_PORT = Number(process.env.IMAP_PORT ?? "993");
const POP_HOST = (process.env.POP_HOST ?? "poppro.zoho.com").trim();
const POP_PORT = Number(process.env.POP_PORT ?? "995");

export const MAIL_USER = (
  process.env.Zoho_PrintAgent_User ??
  process.env.SMTP_USER ??
  ""
).trim();

// Prefer a dedicated IMAP/POP password if set (Zoho app-specific password),
// else reuse the SMTP password.
export const MAIL_PASSWORD = (
  process.env.IMAP_PASSWORD ??
  process.env.Zoho_PrintAgent_IMAP_Password ??
  process.env.SMTP_PASSWORD ??
  ""
).trim();

export function isMailboxConfigured(): boolean {
  return Boolean(MAIL_USER && MAIL_PASSWORD);
}

export function mailboxConfigDiag() {
  const passSource = process.env.IMAP_PASSWORD
    ? "IMAP_PASSWORD"
    : process.env.Zoho_PrintAgent_IMAP_Password
      ? "Zoho_PrintAgent_IMAP_Password"
      : process.env.SMTP_PASSWORD
        ? "SMTP_PASSWORD"
        : "none";
  return {
    imapHost: IMAP_HOST,
    imapPort: IMAP_PORT,
    popHost: POP_HOST,
    popPort: POP_PORT,
    userSet: Boolean(MAIL_USER),
    userLooksLikeEmail: MAIL_USER.includes("@"),
    userLength: MAIL_USER.length,
    passwordSet: Boolean(MAIL_PASSWORD),
    passwordLength: MAIL_PASSWORD.length,
    passwordSource: passSource,
  };
}

export interface RawMailboxMessage {
  uidOrId: string;
  source: Buffer;
  seen?: boolean;
  internalDate?: Date;
}

function formatErr(stage: string, err: unknown, extra = ""): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const e = err as {
    response?: string;
    responseText?: string;
    authenticationFailed?: boolean;
    serverResponseCode?: string;
    code?: string;
  };
  const bits = [
    e.authenticationFailed ? "auth_failed" : null,
    e.response ? `response=${e.response}` : null,
    e.responseText ? `text=${e.responseText}` : null,
    e.serverResponseCode ? `code=${e.serverResponseCode}` : null,
    e.code ? `errCode=${e.code}` : null,
  ].filter(Boolean);
  const diag = mailboxConfigDiag();
  return new Error(
    `${stage}: ${msg}${bits.length ? ` (${bits.join(", ")})` : ""}${extra} ` +
      `[user=${diag.userLength}ch@${diag.userLooksLikeEmail ? "email" : "not-email"}, ` +
      `pass=${diag.passwordLength}ch from ${diag.passwordSource}]`,
  );
}

/** IMAP via imapflow — fetch last `limit` messages (sequence range). */
export async function fetchRecentViaImap(options?: {
  limit?: number;
  includeSeen?: boolean;
}): Promise<RawMailboxMessage[]> {
  const { ImapFlow } = await import("imapflow");
  const limit = options?.limit ?? 40;
  const includeSeen = options?.includeSeen ?? false;

  const hosts = [IMAP_HOST];
  if (IMAP_HOST === "imappro.zoho.com" && !process.env.IMAP_HOST) {
    hosts.push("imap.zoho.com");
  }

  let lastErr: unknown;
  for (const host of hosts) {
    const client = new ImapFlow({
      host,
      port: IMAP_PORT,
      secure: true,
      auth: { user: MAIL_USER, pass: MAIL_PASSWORD },
      logger: false,
      connectionTimeout: 20_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });

    try {
      await client.connect();
    } catch (err) {
      lastErr = formatErr(`IMAP connect ${host}:${IMAP_PORT}`, err);
      try {
        await client.logout();
      } catch {
        /* ignore */
      }
      continue;
    }

    const out: RawMailboxMessage[] = [];
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const total = Number((client.mailbox as { exists?: number } | null)?.exists ?? 0);
        if (total === 0) return out;

        const start = Math.max(1, total - limit + 1);
        for await (const msg of client.fetch(`${start}:${total}`, {
          uid: true,
          source: true,
          flags: true,
          internalDate: true,
        })) {
          const flags = msg.flags ?? new Set<string>();
          const seen = flags.has("\\Seen");
          if (!includeSeen && seen) continue;

          const internal =
            msg.internalDate instanceof Date
              ? msg.internalDate.getTime()
              : msg.internalDate
                ? new Date(msg.internalDate).getTime()
                : Date.now();
          if (internal < sevenDaysAgo) continue;
          if (!msg.source) continue;

          out.push({
            uidOrId: String(msg.uid),
            source: Buffer.isBuffer(msg.source)
              ? msg.source
              : Buffer.from(msg.source as string),
            seen,
            internalDate: msg.internalDate instanceof Date ? msg.internalDate : undefined,
          });
        }
      } finally {
        lock.release();
      }

      // Mark seen
      const uids = out.map((m) => Number(m.uidOrId)).filter((n) => Number.isFinite(n));
      if (uids.length > 0) {
        try {
          await client.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
        } catch {
          /* non-fatal */
        }
      }

      return out;
    } catch (err) {
      lastErr = formatErr(`IMAP fetch on ${host}`, err);
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Minimal SSL POP3 client for Zoho (USER/PASS/STAT/RETR/QUIT).
 * Used when IMAP is disabled by policy but POP is allowed (or vice versa).
 */
export async function fetchRecentViaPop3(options?: {
  limit?: number;
}): Promise<RawMailboxMessage[]> {
  const limit = options?.limit ?? 40;
  const hosts = [POP_HOST];
  if (POP_HOST === "poppro.zoho.com" && !process.env.POP_HOST) {
    hosts.push("pop.zoho.com");
  }

  let lastErr: unknown;
  for (const host of hosts) {
    try {
      return await pop3Session(host, POP_PORT, MAIL_USER, MAIL_PASSWORD, limit);
    } catch (err) {
      lastErr = formatErr(`POP3 ${host}:${POP_PORT}`, err);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function pop3Session(
  host: string,
  port: number,
  user: string,
  pass: string,
  limit: number,
): Promise<RawMailboxMessage[]> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: true });

    let buf = "";
    type Step = "greet" | "user" | "pass" | "stat" | "retr_status" | "retr_body" | "quit";
    let step: Step = "greet";
    let retrList: number[] = [];
    let retrIndex = 0;
    let bodyBuf = "";
    const messages: RawMailboxMessage[] = [];
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      reject(err);
    };

    const ok = (value: RawMailboxMessage[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.end();
      } catch {
        /* ignore */
      }
      resolve(value);
    };

    const send = (cmd: string) => {
      socket.write(cmd + "\r\n");
    };

    const startNextRetr = () => {
      if (retrIndex >= retrList.length) {
        step = "quit";
        send("QUIT");
        return;
      }
      step = "retr_status";
      bodyBuf = "";
      send(`RETR ${retrList[retrIndex]}`);
    };

    const timer = setTimeout(() => fail(new Error("POP3 timeout (30s)")), 30_000);

    socket.setEncoding("utf8");
    socket.on("error", (err) => fail(err));

    socket.on("data", (chunk: string) => {
      buf += chunk;

      // Multiline RETR body: accumulate until bare ".\r\n"
      if (step === "retr_body") {
        bodyBuf += buf;
        buf = "";
        const terminator = "\r\n.\r\n";
        const end = bodyBuf.indexOf(terminator);
        if (end < 0) return;

        const raw = bodyBuf.slice(0, end);
        bodyBuf = bodyBuf.slice(end + terminator.length);
        // Leftover after terminator goes back to buf for next commands
        buf = bodyBuf;
        bodyBuf = "";

        const unstuffed = raw
          .split("\r\n")
          .map((l) => (l.startsWith(".") ? l.slice(1) : l))
          .join("\r\n");

        messages.push({
          uidOrId: `pop-${retrList[retrIndex]}`,
          source: Buffer.from(unstuffed, "utf8"),
        });
        retrIndex += 1;
        startNextRetr();
        // Process any leftover single-line responses in buf
        if (!buf.includes("\r\n")) return;
      }

      const parts = buf.split("\r\n");
      buf = parts.pop() ?? "";

      for (const line of parts) {
        if (step === "retr_body") {
          // Shouldn't normally hit line mode mid-body; reassemble
          bodyBuf += line + "\r\n";
          continue;
        }

        if (step === "greet") {
          if (!line.startsWith("+OK")) return fail(new Error(`greeting rejected: ${line}`));
          step = "user";
          send(`USER ${user}`);
          continue;
        }

        if (step === "user") {
          if (!line.startsWith("+OK")) return fail(new Error(`USER rejected: ${line}`));
          step = "pass";
          send(`PASS ${pass}`);
          continue;
        }

        if (step === "pass") {
          if (!line.startsWith("+OK")) {
            return fail(
              new Error(
                `PASS rejected: ${line}. If IMAP/POP is blocked or TFA is on, create a Zoho Application-Specific Password and set IMAP_PASSWORD in Vercel.`,
              ),
            );
          }
          step = "stat";
          send("STAT");
          continue;
        }

        if (step === "stat") {
          if (!line.startsWith("+OK")) return fail(new Error(`STAT rejected: ${line}`));
          const m = line.match(/^\+OK\s+(\d+)/i);
          const total = m ? Number(m[1]) : 0;
          if (total === 0) {
            step = "quit";
            send("QUIT");
            continue;
          }
          const start = Math.max(1, total - limit + 1);
          retrList = [];
          for (let i = start; i <= total; i++) retrList.push(i);
          retrIndex = 0;
          startNextRetr();
          continue;
        }

        if (step === "retr_status") {
          if (!line.startsWith("+OK")) {
            return fail(new Error(`RETR ${retrList[retrIndex]} rejected: ${line}`));
          }
          // Remainder of this response is multiline body
          step = "retr_body";
          bodyBuf = "";
          continue;
        }

        if (step === "quit") {
          ok(messages);
          return;
        }
      }
    });

    socket.on("end", () => {
      if (!settled) {
        if (messages.length > 0) ok(messages);
        else fail(new Error("POP3 connection closed unexpectedly"));
      }
    });
  });
}

/**
 * Try IMAP first, then POP3. Returns messages + which transport worked.
 */
export async function fetchRecentMailboxMessages(options?: {
  limit?: number;
  includeSeen?: boolean;
}): Promise<{ transport: "imap" | "pop3"; messages: RawMailboxMessage[] }> {
  if (!isMailboxConfigured()) {
    throw new Error(
      "Mailbox not configured — set Zoho_PrintAgent_User and SMTP_PASSWORD (or IMAP_PASSWORD) in Vercel",
    );
  }

  const errors: string[] = [];

  try {
    const messages = await fetchRecentViaImap(options);
    return { transport: "imap", messages };
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  try {
    const messages = await fetchRecentViaPop3({ limit: options?.limit });
    return { transport: "pop3", messages };
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  throw new Error(
    `Could not read Zoho mailbox via IMAP or POP3.\n` +
      errors.map((e, i) => `  ${i + 1}. ${e}`).join("\n") +
      `\n\nZoho checklist:\n` +
      `  • Settings → Mail Accounts → select the mailbox → enable IMAP Access (and POP if needed)\n` +
      `  • Admin: Email Policy must allow IMAP/POP for this user\n` +
      `  • If TFA/SAML is on: create an Application-Specific Password and set IMAP_PASSWORD in Vercel (SMTP can keep working with the normal password)\n` +
      `  • Username must be the full address (${MAIL_USER ? MAIL_USER.replace(/(.{2}).+(@.+)/, "$1…$2") : "not set"})`,
  );
}

/** Parse a raw RFC822 buffer with mailparser. */
export async function parseRawMessage(source: Buffer) {
  return simpleParser(source);
}
