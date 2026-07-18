import { useState } from "react";
import type { GetServerSideProps } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/db";
import { AppHeader, Card, Badge, StatusPill } from "@/components/ui";

interface QueueDocument {
  id: string;
  createdAt: string;
  recipientName: string;
  returnPreference: "DIRECT" | "MANAGED";
  status: string;
}

interface PrintQueueProps {
  userLabel: string;
  documents: QueueDocument[];
}

export const getServerSideProps: GetServerSideProps<PrintQueueProps> = async (context) => {
  const session = await getServerSession(context.req, context.res, authOptions);
  if (!session?.user?.email) {
    return { redirect: { destination: "/login", permanent: false } };
  }

  const user = await prisma.user.findUnique({ where: { email: session.user.email } });
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return { redirect: { destination: "/dashboard", permanent: false } };
  }

  const documents = await prisma.document.findMany({
    where: { status: { in: ["UPLOADED", "QUEUED_FOR_PRINT"] } },
    orderBy: { createdAt: "asc" },
  });

  return {
    props: {
      userLabel: `${user.email} · Secure Facility (JHB)`,
      documents: documents.map((d) => ({
        id: d.id,
        createdAt: d.createdAt.toISOString(),
        recipientName: d.recipientName,
        returnPreference: d.returnPreference,
        status: d.status,
      })),
    },
  };
};

export default function PrintQueue({ userLabel, documents: initialDocuments }: PrintQueueProps) {
  const [documents, setDocuments] = useState(initialDocuments);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<{ id: string; message: string } | null>(null);

  async function handleDownload(id: string) {
    setErrorId(null);
    try {
      const res = await fetch(`/api/documents/${id}/download`);
      if (!res.ok) throw new Error((await res.json()).error ?? "Download failed");
      const { url } = await res.json();
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setErrorId({ id, message: (err as Error).message });
    }
  }

  async function handleMarkPrinted(id: string) {
    setBusyId(id);
    setErrorId(null);
    try {
      const res = await fetch(`/api/documents/${id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "PRINTED" }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to update status");
      setDocuments((prev) => prev.filter((d) => d.id !== id));
    } catch (err) {
      setErrorId({ id, message: (err as Error).message });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="app-shell">
      <AppHeader active="print-queue" userLabel={userLabel} showPrintQueue />
      <main className="app-main">
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div>
            <div className="page-title">Print Queue</div>
            <div className="page-subtitle">
              Documents awaiting secure intake and printing — {documents.length} pending.
            </div>
          </div>

          {documents.length === 0 ? (
            <Card>
              <div style={{ fontSize: 14, color: "var(--text-secondary)" }}>
                Nothing in the print queue right now.
              </div>
            </Card>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {documents.map((doc) => (
                <Card key={doc.id}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: 16,
                    }}
                  >
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ fontFamily: "var(--font-mono, monospace)", fontWeight: 700, fontSize: 15 }}>
                          {doc.id.slice(0, 10).toUpperCase()}
                        </span>
                        <StatusPill status={doc.status} />
                      </div>
                      <div style={{ fontSize: 14, color: "var(--text-primary)" }}>{doc.recipientName}</div>
                      <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                        Uploaded {new Date(doc.createdAt).toLocaleString()}
                      </div>
                      <div>
                        <Badge tone={doc.returnPreference === "MANAGED" ? "teal" : "navy"}>
                          {doc.returnPreference === "MANAGED" ? "Fully Managed Return" : "Direct Return"}
                        </Badge>
                      </div>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <button className="btn btn-secondary" onClick={() => handleDownload(doc.id)}>
                        Download
                      </button>
                      <button
                        className="btn btn-primary"
                        disabled={busyId === doc.id}
                        onClick={() => handleMarkPrinted(doc.id)}
                      >
                        {busyId === doc.id ? "Marking…" : "Mark as Printed"}
                      </button>
                    </div>
                  </div>
                  {errorId?.id === doc.id && (
                    <div className="form-error" style={{ marginTop: 12 }}>
                      {errorId.message}
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
