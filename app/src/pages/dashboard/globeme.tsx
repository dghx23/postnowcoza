import type { GetServerSideProps } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/db";
import { AppHeader, Card, DataTable, StatusPill } from "@/components/ui";

interface OrderRow {
  id: string;
  orderRef: string;
  status: string;
  recipientName: string;
  recipientCity: string;
  productName: string | null;
  productPrice: number | null;
  createdAt: string;
}

interface GlobeMeDashboardProps {
  userLabel: string;
  orders: OrderRow[];
}

export default function GlobeMeDashboard({ userLabel, orders }: GlobeMeDashboardProps) {
  return (
    <div className="app-shell">
      <AppHeader active="globeme" userLabel={userLabel} showPrintQueue showExpress showGlobeme />
      <main className="app-main">
        <Card title="GlobeMe — Shopping Orders">
          {orders.length === 0 ? (
            <p style={{ color: "var(--text-secondary)" }}>No orders yet. Orders are created via the WhatsApp shopping bot.</p>
          ) : (
            <DataTable
              columns={["Ref", "Status", "Recipient", "City", "Product", "Item Price (USD)", "Created"]}
              rows={orders.map((o) => [
                o.orderRef,
                <StatusPill key={o.id} status={o.status} />,
                o.recipientName,
                o.recipientCity,
                o.productName ?? "—",
                o.productPrice != null ? `$${o.productPrice.toFixed(2)}` : "—",
                new Date(o.createdAt).toLocaleDateString(),
              ])}
            />
          )}
        </Card>
      </main>
    </div>
  );
}

export const getServerSideProps: GetServerSideProps<GlobeMeDashboardProps> = async (context) => {
  const session = await getServerSession(context.req, context.res, authOptions);
  if (!session?.user?.email) {
    return { redirect: { destination: "/login", permanent: false } };
  }

  const user = await prisma.user.findUnique({ where: { email: session.user.email } });
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return { redirect: { destination: "/login", permanent: false } };
  }

  const orders = await prisma.shoppingOrder.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return {
    props: {
      userLabel: user.email,
      orders: orders.map((o) => ({
        id: o.id,
        orderRef: o.orderRef,
        status: o.status,
        recipientName: o.recipientName,
        recipientCity: o.recipientCity,
        productName: o.productName,
        productPrice: o.productPrice,
        createdAt: o.createdAt.toISOString(),
      })),
    },
  };
};
