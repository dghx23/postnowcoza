import { useEffect, useRef, useState } from "react";
import type { GetServerSideProps } from "next";
import Link from "next/link";
import { useRouter } from "next/router";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/db";
import { AppHeader, Card, Alert, Badge, StatusPill } from "@/components/ui";
import { getPayfastConfig } from "@/lib/payfast";
import { validatePaymentRequestToken } from "@/lib/paymentRequestEmail";

interface PayPageProps {
  userLabel: string;
  documentId: string;
  recipientName: string;
  recipientEmail: string;
  recipientPhone: string;
  status: string;
  amount: number;
  alreadyPaid: boolean;
  payfastReady: boolean;
  addressLine: string;
  printColorMode: string;
  printCopies: number;
  returnPreference: string;
  /** Logged-in staff seeing request-payment UI (not guest token pay) */
  isStaffRequestView: boolean;
  /** Guest paying via emailed link */
  isGuest: boolean;
  payToken: string | null;
}

export const getServerSideProps: GetServerSideProps<PayPageProps> = async (context) => {
  const id = context.params?.id as string;
  const token =
    typeof context.query.token === "string" ? context.query.token : null;

  const document = await prisma.document.findUnique({ where: { id } });
  if (!document) return { notFound: true };

  const session = await getServerSession(context.req, context.res, authOptions);
  const user = session?.user?.email
    ? await prisma.user.findUnique({ where: { email: session.user.email } })
    : null;

  const isStaff = user?.role === "STAFF" || user?.role === "ADMIN";
  const isOwner = Boolean(user && document.ownerId === user.id);
  const tokenOk = token ? await validatePaymentRequestToken(id, token) : false;

  if (!isStaff && !isOwner && !tokenOk) {
    if (!session?.user?.email) {
      return {
        redirect: {
          destination: `/login?callbackUrl=${encodeURIComponent(`/pay/${id}${token ? `?token=${token}` : ""}`)}`,
          permanent: false,
        },
      };
    }
    return { redirect: { destination: "/dashboard", permanent: false } };
  }

  let amount = document.dispatchFee;
  if (amount == null || amount <= 0) {
    amount = Number(process.env.DEFAULT_DISPATCH_FEE ?? "149") || 149;
    await prisma.document.update({
      where: { id },
      data: { dispatchFee: amount },
    });
  }

  const paid = await prisma.payment.findFirst({
    where: { documentId: id, status: "PAID" },
  });

  const cfg = getPayfastConfig();

  // Staff default: request-payment UI. Guest token or customer owner: pay UI.
  // Staff can still open ?pay=1 to pay themselves.
  const forcePay =
    context.query.pay === "1" || context.query.pay === "true" || Boolean(tokenOk && !isStaff);
  const isStaffRequestView = Boolean(isStaff && !forcePay && !tokenOk);
  const isGuest = Boolean(tokenOk && !user);

  return {
    props: {
      userLabel: session?.user?.email ?? (isGuest ? "Payment guest" : ""),
      documentId: document.id,
      recipientName: document.recipientName,
      recipientEmail: document.recipientEmail,
      recipientPhone: document.recipientPhone,
      status: document.status,
      amount,
      alreadyPaid: Boolean(paid),
      payfastReady: cfg.configured,
      addressLine: [
        document.streetAddress,
        document.localArea,
        document.city,
        document.zone,
        document.postalCode,
      ]
        .filter(Boolean)
        .join(", "),
      printColorMode: document.printColorMode,
      printCopies: document.printCopies,
      returnPreference: document.returnPreference,
      isStaffRequestView,
      isGuest,
      payToken: tokenOk ? token : null,
    },
  };
};

export default function PayPage({
  userLabel,
  documentId,
  recipientName,
  recipientEmail,
  recipientPhone,
  status,
  amount,
  alreadyPaid,
  payfastReady,
  addressLine,
  printColorMode,
  printCopies,
  returnPreference,
  isStaffRequestView,
  isGuest,
  payToken,
}: PayPageProps) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [requestEmail, setRequestEmail] = useState(recipientEmail || "");
  const [requestSent, setRequestSent] = useState<string | null>(null);

  useEffect(() => {
    if (!router.isReady) return;
    const s = router.query.status;
    if (s === "return") {
      setBanner(
        "If you completed payment, it may take a few seconds to confirm. We’ll update tracking automatically.",
      );
    }
    if (s === "cancelled") {
      setBanner("Payment was cancelled. You can try again whenever you’re ready.");
    }
  }, [router.isReady, router.query.status]);

  async function startPayFast() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/documents/${documentId}/pay`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(payToken ? { "x-payment-token": payToken } : {}),
        },
        body: JSON.stringify(payToken ? { token: payToken } : {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not start payment");

      if (data.alreadyPaid) {
        router.push(data.redirect ?? `/tracking/${documentId}?payment=success`);
        return;
      }

      const form = formRef.current;
      if (!form || !data.action || !data.fields) {
        throw new Error("Invalid PayFast response");
      }

      form.action = data.action;
      form.innerHTML = "";
      for (const [key, value] of Object.entries(data.fields as Record<string, string>)) {
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = key;
        input.value = String(value);
        form.appendChild(input);
      }
      form.submit();
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  }

  async function sendPaymentRequest() {
    setLoading(true);
    setError(null);
    setRequestSent(null);
    try {
      const res = await fetch(`/api/documents/${documentId}/request-payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: requestEmail.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not send payment request");
      setRequestSent(data.message ?? `Payment request sent to ${requestEmail}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const colourLabel = printColorMode === "color" ? "Colour" : "Black & white";
  const returnLabel =
    returnPreference === "MANAGED" ? "Fully managed return via PostNow" : "Direct return";

  const orderSummary = (
    <div className="pay-summary">
      <div className="pay-row">
        <span>Reference</span>
        <strong>#{documentId.slice(0, 10).toUpperCase()}</strong>
      </div>
      <div className="pay-row">
        <span>Recipient</span>
        <strong>{recipientName}</strong>
      </div>
      <div className="pay-row">
        <span>Deliver to</span>
        <strong style={{ textAlign: "right", maxWidth: 280 }}>{addressLine}</strong>
      </div>
      <div className="pay-row">
        <span>Phone</span>
        <strong>{recipientPhone || "—"}</strong>
      </div>
      <div className="pay-row">
        <span>Print</span>
        <strong>
          {colourLabel} · {printCopies} {printCopies === 1 ? "copy" : "copies"}
        </strong>
      </div>
      <div className="pay-row">
        <span>Return</span>
        <strong>{returnLabel}</strong>
      </div>
      <div className="pay-row">
        <span>Service</span>
        <strong>Secure physical document dispatch</strong>
      </div>
      <div className="pay-row pay-total">
        <span>Amount due</span>
        <strong className="pay-amount">R {amount.toFixed(2)}</strong>
      </div>
    </div>
  );

  if (alreadyPaid) {
    return (
      <div className="app-shell">
        {!isGuest && <AppHeader active="tracking" userLabel={userLabel} showPrintQueue showRoadmap />}
        <main className="app-main">
          <Card title="Payment complete">
            <Alert title="Already paid">
              This dispatch fee has been paid. Courier collection is scheduled for the next day once
              printing is done (or immediately if already printed).
            </Alert>
            <div style={{ display: "flex", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
              <Link href={`/tracking/${documentId}`} className="btn btn-primary">
                View tracking →
              </Link>
              {!isGuest && (
                <Link href="/dashboard" className="btn btn-secondary">
                  Dashboard
                </Link>
              )}
            </div>
          </Card>
        </main>
      </div>
    );
  }

  // ─── Staff: request payment by email ───────────────────────────────
  if (isStaffRequestView) {
    return (
      <div className="app-shell">
        <AppHeader active="dispatch" userLabel={userLabel} showPrintQueue showRoadmap />
        <main className="app-main">
          <div className="pay-page">
            <div className="pay-page-head">
              <div>
                <div className="page-title">Request payment of dispatch fee</div>
                <div className="page-subtitle">
                  Staff job entry · send the customer a secure PayFast link · ref #
                  {documentId.slice(0, 10).toUpperCase()}
                </div>
              </div>
              <StatusPill status={status} />
            </div>

            {requestSent && (
              <Alert title="Payment request sent">{requestSent}</Alert>
            )}

            <div className="pay-grid">
              <Card title="Order summary">
                {orderSummary}
                <p className="pay-note">
                  This job was entered by staff (same details a customer would provide online). Send a
                  payment request so the payer can complete checkout without logging into the staff
                  account.
                </p>
              </Card>

              <Card title="Send payment request">
                <div className="field">
                  <label htmlFor="pay-request-email">Email address to send the payment request to</label>
                  <input
                    id="pay-request-email"
                    type="email"
                    value={requestEmail}
                    onChange={(e) => setRequestEmail(e.target.value)}
                    placeholder="customer@example.com"
                    required
                    autoComplete="email"
                  />
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>
                    Defaults to the recipient email from the job. Change it if the payer is different.
                  </div>
                </div>

                <p className="pay-note" style={{ marginTop: 14 }}>
                  The email includes full order details (recipient, address, print options, amount) and a
                  one-time secure link to pay R {amount.toFixed(2)}.
                </p>

                <div className="pay-actions">
                  <button
                    type="button"
                    className="btn btn-primary pay-btn"
                    disabled={loading || !requestEmail.trim()}
                    onClick={() => void sendPaymentRequest()}
                  >
                    {loading ? "Sending…" : "Send payment request email"}
                  </button>
                  <Link
                    href={`/pay/${documentId}?pay=1`}
                    className="btn btn-secondary"
                  >
                    Pay now myself
                  </Link>
                  <Link href={`/tracking/${documentId}`} className="btn btn-secondary">
                    Open tracking
                  </Link>
                  <Link href="/print-queue" className="btn btn-secondary">
                    Print queue
                  </Link>
                </div>
                {error && <div className="form-error" style={{ marginTop: 12 }}>{error}</div>}
              </Card>
            </div>

            <div className="pay-methods-strip" aria-label="Accepted payment methods">
              {[
                ["pm-visa.svg", "Visa"],
                ["pm-mastercard.svg", "Mastercard"],
                ["pm-amex.svg", "American Express"],
                ["pm-instant-eft.svg", "Instant EFT"],
                ["pm-apple-pay.svg", "Apple Pay"],
                ["pm-samsung-pay.svg", "Samsung Pay"],
                ["pm-google-pay.svg", "Google Pay"],
                ["pm-capitec-pay.svg", "Capitec Pay"],
                ["pm-mobicred.svg", "Mobicred"],
                ["pm-moretyme.svg", "MoreTyme"],
                ["pm-scode.svg", "SCode"],
                ["pm-snapscan.svg", "SnapScan"],
                ["pm-zapper.svg", "Zapper"],
                ["pm-masterpass.svg", "Masterpass"],
                ["pm-rcs.svg", "RCS"],
              ].map(([file, label]) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={file}
                  src={`/pay-logos/${file}`}
                  alt={label}
                  title={label}
                  height={48}
                  width={72}
                />
              ))}
            </div>
          </div>
        </main>
      </div>
    );
  }

  // ─── Customer / guest / staff pay-now ──────────────────────────────
  return (
    <div className="app-shell">
      {!isGuest && (
        <AppHeader
          active="tracking"
          userLabel={userLabel}
          showPrintQueue={!isGuest}
          showRoadmap={!isGuest}
        />
      )}
      {isGuest && (
        <div className="pay-guest-bar">
          <span className="pay-guest-brand">
            Post<span>Now</span>
          </span>
          <span className="pay-guest-meta">Secure payment · dispatch fee</span>
        </div>
      )}
      <main className="app-main">
        <div className="pay-page">
          <div className="pay-page-head">
            <div>
              <div className="page-title">Pay dispatch fee</div>
              <div className="page-subtitle">
                Secure checkout via PayFast · ref #{documentId.slice(0, 10).toUpperCase()}
              </div>
            </div>
            <StatusPill status={status} />
          </div>

          {banner && (
            <Alert title="Payment status">
              {banner}{" "}
              {!isGuest && (
                <Link href={`/tracking/${documentId}`} style={{ fontWeight: 600 }}>
                  Open tracking
                </Link>
              )}
            </Alert>
          )}

          {!payfastReady && (
            <Alert title="PayFast not configured" tone="danger">
              Set <code>Merchant_ID_Payfast</code> and <code>Merchant_Key_Payfast</code> in Vercel, then
              redeploy.
            </Alert>
          )}

          <div className="pay-grid">
            <Card title="Order summary">
              {orderSummary}

              <p className="pay-note">
                After payment, we print your document and book <strong>courier collection for the next
                day</strong> from our facility. You’ll get live tracking on your document page.
              </p>

              <div className="pay-actions">
                <button
                  type="button"
                  className="btn btn-primary pay-btn"
                  disabled={loading || !payfastReady}
                  onClick={() => void startPayFast()}
                >
                  {loading ? "Redirecting to PayFast…" : "Pay securely with PayFast"}
                </button>
                {!isGuest && (
                  <Link href={`/tracking/${documentId}`} className="btn btn-secondary">
                    Skip for now · view tracking
                  </Link>
                )}
              </div>
              {error && <div className="form-error" style={{ marginTop: 12 }}>{error}</div>}
            </Card>

            <Card title="What happens next">
              <ol className="pay-steps">
                <li>
                  <strong>Pay</strong> — secure card / EFT via PayFast
                </li>
                <li>
                  <strong>We print</strong> — secure intake at our facility
                </li>
                <li>
                  <strong>Courier booked</strong> — collection the <em>next day</em> after payment (once
                  printed)
                </li>
                <li>
                  <strong>Track</strong> — live updates on your tracking page
                </li>
              </ol>
              <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Badge tone="success">POPIA</Badge>
                <Badge tone="teal">Next-day collection</Badge>
              </div>
            </Card>
          </div>

          <div className="pay-methods-strip" aria-label="Accepted payment methods">
            {[
              ["pm-visa.svg", "Visa"],
              ["pm-mastercard.svg", "Mastercard"],
              ["pm-amex.svg", "American Express"],
              ["pm-instant-eft.svg", "Instant EFT"],
              ["pm-apple-pay.svg", "Apple Pay"],
              ["pm-samsung-pay.svg", "Samsung Pay"],
              ["pm-google-pay.svg", "Google Pay"],
              ["pm-capitec-pay.svg", "Capitec Pay"],
              ["pm-mobicred.svg", "Mobicred"],
              ["pm-moretyme.svg", "MoreTyme"],
              ["pm-scode.svg", "SCode"],
              ["pm-snapscan.svg", "SnapScan"],
              ["pm-zapper.svg", "Zapper"],
              ["pm-masterpass.svg", "Masterpass"],
              ["pm-rcs.svg", "RCS"],
            ].map(([file, label]) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={file}
                src={`/pay-logos/${file}`}
                alt={label}
                title={label}
                height={48}
                width={72}
              />
            ))}
          </div>

          <form ref={formRef} method="POST" style={{ display: "none" }} />
        </div>
      </main>
    </div>
  );
}
