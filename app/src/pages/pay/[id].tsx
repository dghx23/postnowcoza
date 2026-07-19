import { useEffect, useRef, useState } from "react";
import type { GetServerSideProps } from "next";
import Link from "next/link";
import { useRouter } from "next/router";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/db";
import { AppHeader, Card, Alert, Badge, StatusPill } from "@/components/ui";
import { getPayfastConfig } from "@/lib/payfast";

interface PayPageProps {
  userLabel: string;
  documentId: string;
  recipientName: string;
  status: string;
  amount: number;
  alreadyPaid: boolean;
  payfastReady: boolean;
  addressLine: string;
}

export const getServerSideProps: GetServerSideProps<PayPageProps> = async (context) => {
  const session = await getServerSession(context.req, context.res, authOptions);
  if (!session?.user?.email) {
    return { redirect: { destination: "/login", permanent: false } };
  }

  const id = context.params?.id as string;
  const user = await prisma.user.findUnique({ where: { email: session.user.email } });
  if (!user) return { redirect: { destination: "/login", permanent: false } };

  const document = await prisma.document.findUnique({ where: { id } });
  if (!document) return { notFound: true };

  const isStaff = user.role === "STAFF" || user.role === "ADMIN";
  if (!isStaff && document.ownerId !== user.id) {
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

  return {
    props: {
      userLabel: session.user.email ?? "",
      documentId: document.id,
      recipientName: document.recipientName,
      status: document.status,
      amount,
      alreadyPaid: Boolean(paid),
      payfastReady: cfg.configured,
      addressLine: [
        document.streetAddress,
        document.localArea,
        document.city,
        document.postalCode,
      ]
        .filter(Boolean)
        .join(", "),
    },
  };
};

export default function PayPage({
  userLabel,
  documentId,
  recipientName,
  status,
  amount,
  alreadyPaid,
  payfastReady,
  addressLine,
}: PayPageProps) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

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
      const res = await fetch(`/api/documents/${documentId}/pay`, { method: "POST" });
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

  if (alreadyPaid) {
    return (
      <div className="app-shell">
        <AppHeader active="tracking" userLabel={userLabel} />
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
              <Link href="/dashboard" className="btn btn-secondary">
                Dashboard
              </Link>
            </div>
          </Card>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <AppHeader active="tracking" userLabel={userLabel} />
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
              <Link href={`/tracking/${documentId}`} style={{ fontWeight: 600 }}>
                Open tracking
              </Link>
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
              <div className="pay-summary">
                <div className="pay-row">
                  <span>Recipient</span>
                  <strong>{recipientName}</strong>
                </div>
                <div className="pay-row">
                  <span>Deliver to</span>
                  <strong style={{ textAlign: "right", maxWidth: 280 }}>{addressLine}</strong>
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
                <Link href={`/tracking/${documentId}`} className="btn btn-secondary">
                  Skip for now · view tracking
                </Link>
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
              <div className="pay-brand-row" aria-label="Payment providers">
                <div className="pay-brand">
                  <span className="pay-brand-label">Online</span>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/pay-logos/logo-payfast.svg" alt="Payfast" height={22} width={100} />
                </div>
                <div className="pay-brand">
                  <span className="pay-brand-label">In person</span>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/pay-logos/logo-network.svg" alt="Network International" height={22} width={130} />
                </div>
              </div>
              <div className="pay-method-icons" aria-label="Accepted methods">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/pay-logos/pm-credit-card.svg" alt="Credit Card" title="Credit Card" height={28} width={42} />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/pay-logos/pm-instant-eft.svg" alt="Instant EFT" title="Instant EFT" height={28} width={42} />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/pay-logos/pm-amex.svg" alt="American Express" title="American Express" height={28} width={42} />
              </div>
            </Card>
          </div>

          {/* Hidden form used for PayFast POST redirect */}
          <form ref={formRef} method="POST" style={{ display: "none" }} />
        </div>
      </main>
    </div>
  );
}
