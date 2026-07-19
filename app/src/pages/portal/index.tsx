import type { GetServerSideProps } from "next";
import Link from "next/link";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { AppHeader, Card, Badge } from "@/components/ui";

/**
 * PARKED — Customer portal shell.
 * Not linked from staff sidebar. Self-serve dispatch + classic Pay dispatch fee
 * live under /portal/* for when we ship the customer-facing product.
 */
export const getServerSideProps: GetServerSideProps = async (context) => {
  const session = await getServerSession(context.req, context.res, authOptions);
  if (!session?.user?.email) {
    return { redirect: { destination: "/login?callbackUrl=/portal", permanent: false } };
  }
  return { props: { userLabel: session.user.email } };
};

export default function CustomerPortalParked({ userLabel }: { userLabel: string }) {
  return (
    <div className="app-shell">
      <AppHeader active="dashboard" userLabel={userLabel} />
      <main className="app-main">
        <div className="page-head" style={{ marginBottom: 20 }}>
          <div>
            <div className="page-title">Customer portal</div>
            <div className="page-subtitle">Parked for a later release · not the live staff ops app</div>
          </div>
          <Badge tone="navy">Parked</Badge>
        </div>

        <Card title="Reserved for customers">
          <p style={{ fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.55, margin: "0 0 16px" }}>
            The live product surface today is the <strong>staff</strong> dashboard (manual job entry,
            print queue, printer hub, finance). Customer self-serve flows are preserved here so we can
            wire a proper portal without mixing it into ops.
          </p>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14, lineHeight: 1.7, color: "var(--text-primary)" }}>
            <li>
              <Link href="/portal/dispatch/new" style={{ fontWeight: 600, color: "var(--teal-700)" }}>
                New secure dispatch (customer)
              </Link>
              {" — "}same form as staff entry; after submit → classic{" "}
              <strong>Pay dispatch fee</strong> (self-serve PayFast).
            </li>
            <li>
              <strong>Pay dispatch fee</strong> — existing <code>/pay/[id]</code> customer/guest UI
              (not the staff “request payment by email” screen). Opened after customer upload or via
              emailed payment-request token.
            </li>
          </ul>
          <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "16px 0 0", lineHeight: 1.5 }}>
            Staff should use <Link href="/dispatch/new">/dispatch/new</Link> and the payment-request
            flow after submit. Track this work on the staff Roadmap.
          </p>
        </Card>
      </main>
    </div>
  );
}
