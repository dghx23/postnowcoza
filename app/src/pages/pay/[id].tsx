import { useEffect, useRef, useState } from "react";
import type { GetServerSideProps } from "next";
import Link from "next/link";
import { useRouter } from "next/router";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/db";
import { AppHeader, Card, Alert, Badge, StatusPill, Modal } from "@/components/ui";
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
  waived: boolean;
  createdVia: string;
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
    where: { documentId: id, status: { in: ["PAID", "WAIVED"] } },
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
      waived: paid?.status === "WAIVED",
      createdVia: document.createdVia,
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
  waived,
  createdVia,
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
  const [requestPhone, setRequestPhone] = useState(recipientPhone || "");
  const [requestSent, setRequestSent] = useState<string | null>(null);
  const [sendingChannel, setSendingChannel] = useState<"email" | "whatsapp" | null>(null);

  // Manual-entry accountability (staff-created jobs only).
  const isManualEntry = createdVia === "STAFF";
  const [justification, setJustification] = useState("");
  const [isTestEntry, setIsTestEntry] = useState(false);
  const [justifyModalOpen, setJustifyModalOpen] = useState(false);
  const [justifyError, setJustifyError] = useState<string | null>(null);
  const pendingActionRef = useRef<(() => void) | null>(null);

  const [cancelling, setCancelling] = useState(false);
  const [cancelled, setCancelled] = useState(false);

  const [waiveOpen, setWaiveOpen] = useState(false);
  const [waiveAmount, setWaiveAmount] = useState(String(amount));
  const [waiveJustification, setWaiveJustification] = useState("");
  const [waiveConfirming, setWaiveConfirming] = useState(false);
  const [waiveBusy, setWaiveBusy] = useState(false);
  const [justWaived, setJustWaived] = useState(false);

  function runWithJustification(action: () => void) {
    if (!isManualEntry || justification.trim()) {
      action();
      return;
    }
    pendingActionRef.current = action;
    setJustifyError(null);
    setJustifyModalOpen(true);
  }

  function confirmJustification() {
    if (!justification.trim()) {
      setJustifyError("Justification is required.");
      return;
    }
    setJustifyModalOpen(false);
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    if (action) action();
  }

  async function cancelManualEntry() {
    setCancelling(true);
    setError(null);
    try {
      const res = await fetch(`/api/documents/${documentId}/cancel-payment-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ justification: justification.trim(), isTestEntry }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not cancel");
      setCancelled(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCancelling(false);
    }
  }

  async function confirmWaive() {
    setWaiveConfirming(false);
    setWaiveBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/documents/${documentId}/waive-payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          justification: waiveJustification.trim(),
          amount: Number(waiveAmount),
          isTestEntry,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not process at no cost");
      setJustWaived(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWaiveBusy(false);
    }
  }

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

  async function sendPaymentRequest(channel: "email" | "whatsapp") {
    setLoading(true);
    setSendingChannel(channel);
    setError(null);
    setRequestSent(null);
    try {
      const manualEntryBody = isManualEntry ? { justification: justification.trim(), isTestEntry } : {};
      const body =
        channel === "whatsapp"
          ? { channel: "whatsapp", phone: requestPhone.trim(), ...manualEntryBody }
          : { channel: "email", email: requestEmail.trim(), ...manualEntryBody };
      const res = await fetch(`/api/documents/${documentId}/request-payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not send payment request");
      setRequestSent(
        data.message ??
          (channel === "whatsapp"
            ? `Payment request WhatsApp sent to ${requestPhone}`
            : `Payment request sent to ${requestEmail}`)
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
      setSendingChannel(null);
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

  if (cancelled) {
    return (
      <div className="app-shell">
        <AppHeader active="dispatch" userLabel={userLabel} showPrintQueue showRoadmap />
        <main className="app-main">
          <Card title="Payment request cancelled">
            <Alert title="Cancelled">This manual entry's payment request was cancelled and won&apos;t be sent.</Alert>
            <div style={{ display: "flex", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
              <Link href={`/tracking/${documentId}`} className="btn btn-primary">
                View tracking →
              </Link>
              <Link href="/dashboard" className="btn btn-secondary">
                Dashboard
              </Link>
            </div>
          </Card>
        </main>
      </div>
    );
  }

  if (justWaived) {
    return (
      <div className="app-shell">
        <AppHeader active="dispatch" userLabel={userLabel} showPrintQueue showRoadmap />
        <main className="app-main">
          <Card title="Processed at no cost">
            <Alert title="Recorded">
              This job was processed at no cost. It's queued in the Finance section for review.
            </Alert>
            <div style={{ display: "flex", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
              <Link href={`/tracking/${documentId}`} className="btn btn-primary">
                View tracking →
              </Link>
              <Link href="/finance" className="btn btn-secondary">
                Finance
              </Link>
            </div>
          </Card>
        </main>
      </div>
    );
  }

  if (alreadyPaid) {
    return (
      <div className="app-shell">
        {!isGuest && <AppHeader active="tracking" userLabel={userLabel} showPrintQueue showRoadmap />}
        <main className="app-main">
          <Card title={waived ? "Processed at no cost" : "Payment complete"}>
            <Alert title={waived ? "Processed at no cost" : "Already paid"}>
              {waived
                ? "This dispatch fee was processed at no cost. Courier collection is scheduled for the next day once printing is done (or immediately if already printed)."
                : "This dispatch fee has been paid. Courier collection is scheduled for the next day once printing is done (or immediately if already printed)."}
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

              {isManualEntry && (
                <Card title="Manual entry justification">
                  <div className="field">
                    <label htmlFor="manual-justification">Why was this entered manually?</label>
                    <textarea
                      id="manual-justification"
                      rows={3}
                      value={justification}
                      onChange={(e) => setJustification(e.target.value)}
                      placeholder="e.g. Customer called in, couldn't use the online form"
                    />
                  </div>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginTop: 10 }}>
                    <input type="checkbox" checked={isTestEntry} onChange={(e) => setIsTestEntry(e.target.checked)} />
                    This is a test entry
                  </label>

                  <div style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--border-default)" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={waiveOpen}
                        onChange={(e) => {
                          setWaiveOpen(e.target.checked);
                          if (!e.target.checked) setWaiveConfirming(false);
                        }}
                      />
                      Process this job at no cost (at our expense)
                    </label>
                    {waiveOpen && (
                      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                        <div className="field">
                          <label htmlFor="waive-amount">Exact loss amount (ZAR)</label>
                          <input
                            id="waive-amount"
                            type="number"
                            min="0.01"
                            step="0.01"
                            value={waiveAmount}
                            onChange={(e) => setWaiveAmount(e.target.value)}
                          />
                        </div>
                        <div className="field">
                          <label htmlFor="waive-justification">Justification for processing at no cost</label>
                          <textarea
                            id="waive-justification"
                            rows={3}
                            value={waiveJustification}
                            onChange={(e) => setWaiveJustification(e.target.value)}
                            placeholder="Why is PostNow absorbing this cost?"
                          />
                        </div>
                        <div>
                          <button
                            type="button"
                            className="btn btn-primary"
                            disabled={
                              waiveBusy || !waiveJustification.trim() || !(Number(waiveAmount) > 0)
                            }
                            onClick={() => setWaiveConfirming(true)}
                          >
                            {waiveBusy ? "Processing…" : "Confirm no-cost processing"}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </Card>
              )}

              <Card title="Send payment request">
                <div className="field">
                  <label htmlFor="pay-request-email">Email address to send the payment request to</label>
                  <input
                    id="pay-request-email"
                    type="email"
                    value={requestEmail}
                    onChange={(e) => setRequestEmail(e.target.value)}
                    placeholder="customer@example.com"
                    autoComplete="email"
                  />
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>
                    Defaults to the recipient email from the job. Change it if the payer is different.
                  </div>
                </div>

                <div className="field" style={{ marginTop: 16 }}>
                  <label htmlFor="pay-request-phone">WhatsApp number to send the payment request to</label>
                  <input
                    id="pay-request-phone"
                    type="tel"
                    value={requestPhone}
                    onChange={(e) => setRequestPhone(e.target.value)}
                    placeholder="0731234567 or +27731234567"
                    autoComplete="tel"
                  />
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 6 }}>
                    Defaults to the recipient phone from the job. SA numbers starting with 0 are sent as +27.
                  </div>
                </div>

                <p className="pay-note" style={{ marginTop: 14 }}>
                  Email and WhatsApp both include full order details (recipient, address, print options,
                  amount) and a one-time secure link to pay R {amount.toFixed(2)}. You can send either or both.
                </p>

                <div className="pay-actions">
                  <button
                    type="button"
                    className="btn btn-primary pay-btn"
                    disabled={loading || !requestEmail.trim()}
                    onClick={() => runWithJustification(() => void sendPaymentRequest("email"))}
                  >
                    {loading && sendingChannel === "email"
                      ? "Sending email…"
                      : "Send payment request email"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-whatsapp pay-btn"
                    disabled={loading || !requestPhone.trim()}
                    onClick={() => runWithJustification(() => void sendPaymentRequest("whatsapp"))}
                  >
                    {loading && sendingChannel === "whatsapp"
                      ? "Sending WhatsApp…"
                      : "Send payment request WhatsApp"}
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
                  {isManualEntry && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={cancelling}
                      onClick={() => runWithJustification(() => void cancelManualEntry())}
                    >
                      {cancelling ? "Cancelling…" : "Cancel this job"}
                    </button>
                  )}
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

        {justifyModalOpen && (
          <Modal title="Justification required" onClose={() => setJustifyModalOpen(false)}>
            <div className="field">
              <label htmlFor="justify-modal-text">Why was this entered manually?</label>
              <textarea
                id="justify-modal-text"
                rows={3}
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
                autoFocus
              />
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginTop: 10 }}>
              <input type="checkbox" checked={isTestEntry} onChange={(e) => setIsTestEntry(e.target.checked)} />
              This is a test entry
            </label>
            {justifyError && <div className="form-error" style={{ marginTop: 10 }}>{justifyError}</div>}
            <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", marginTop: 16 }}>
              <button type="button" className="btn btn-secondary" onClick={() => setJustifyModalOpen(false)}>
                Back
              </button>
              <button type="button" className="btn btn-primary" onClick={confirmJustification}>
                Continue
              </button>
            </div>
          </Modal>
        )}

        {waiveConfirming && (
          <Modal title="Confirm processing at no cost" onClose={() => setWaiveConfirming(false)}>
            <p style={{ fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.55 }}>
              This will record a <strong>R {Number(waiveAmount || 0).toFixed(2)}</strong> loss for this job and
              mark it as processed at no cost. It will appear in the Finance section's manual entry review queue.
              Are you sure?
            </p>
            <div style={{ display: "flex", gap: 12, justifyContent: "flex-end", marginTop: 16 }}>
              <button type="button" className="btn btn-secondary" onClick={() => setWaiveConfirming(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void confirmWaive()}>
                Confirm — process at no cost
              </button>
            </div>
          </Modal>
        )}
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
