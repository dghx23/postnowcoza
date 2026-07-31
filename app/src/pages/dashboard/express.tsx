import type { GetServerSideProps } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/db";
import { AppHeader, Card, DataTable, StatusPill } from "@/components/ui";

interface BookingRow {
  id: string;
  bookingRef: string;
  status: string;
  senderPhone: string;
  recipientName: string | null;
  price: number | null;
  scheduledDate: string | null;
  createdAt: string;
}

interface ExpressDashboardProps {
  userLabel: string;
  bookings: BookingRow[];
}

export default function ExpressDashboard({ userLabel, bookings }: ExpressDashboardProps) {
  return (
    <div className="app-shell">
      <AppHeader active="express" userLabel={userLabel} showPrintQueue showExpress showGlobeme />
      <main className="app-main">
        <Card title="PostNow Express — Courier Bookings">
          {bookings.length === 0 ? (
            <p style={{ color: "var(--text-secondary)" }}>No bookings yet. Bookings are created via the WhatsApp courier bot.</p>
          ) : (
            <DataTable
              columns={["Ref", "Status", "Sender", "Recipient", "Price", "Scheduled", "Created"]}
              rows={bookings.map((b) => [
                b.bookingRef,
                <StatusPill key={b.id} status={b.status} />,
                b.senderPhone,
                b.recipientName ?? "—",
                b.price != null ? `R${b.price.toFixed(2)}` : "—",
                b.scheduledDate ?? "—",
                new Date(b.createdAt).toLocaleDateString(),
              ])}
            />
          )}
        </Card>
      </main>
    </div>
  );
}

export const getServerSideProps: GetServerSideProps<ExpressDashboardProps> = async (context) => {
  const session = await getServerSession(context.req, context.res, authOptions);
  if (!session?.user?.email) {
    return { redirect: { destination: "/login", permanent: false } };
  }

  const user = await prisma.user.findUnique({ where: { email: session.user.email } });
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return { redirect: { destination: "/login", permanent: false } };
  }

  const bookings = await prisma.courierBooking.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return {
    props: {
      userLabel: user.email,
      bookings: bookings.map((b) => ({
        id: b.id,
        bookingRef: b.bookingRef,
        status: b.status,
        senderPhone: b.senderPhone,
        recipientName: b.recipientName,
        price: b.price,
        scheduledDate: b.scheduledDate,
        createdAt: b.createdAt.toISOString(),
      })),
    },
  };
};
