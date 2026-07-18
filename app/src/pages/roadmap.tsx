import { useState } from "react";
import type { GetServerSideProps } from "next";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/db";
import { AppHeader, Card, Badge, MetricTile } from "@/components/ui";

type Priority = "HIGH" | "MEDIUM" | "LOW";
type Status = "NOT_STARTED" | "IN_PROGRESS" | "READY" | "IMPLEMENTED";

interface Feature {
  id: string;
  name: string;
  priority: Priority;
  status: Status;
  comment: string | null;
  checked: boolean;
  createdAt: string;
  createdBy: string;
}

interface RoadmapProps {
  userLabel: string;
  initialFeatures: Feature[];
}

const PRIORITY_RANK: Record<Priority, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const PRIORITY_TONE: Record<Priority, "navy" | "teal" | "success"> = {
  HIGH: "navy",
  MEDIUM: "teal",
  LOW: "success",
};
const STATUS_LABEL: Record<Status, string> = {
  NOT_STARTED: "Not Started",
  IN_PROGRESS: "In Progress",
  READY: "Ready",
  IMPLEMENTED: "Implemented",
};

export const getServerSideProps: GetServerSideProps<RoadmapProps> = async (context) => {
  const session = await getServerSession(context.req, context.res, authOptions);
  if (!session?.user?.email) {
    return { redirect: { destination: "/login", permanent: false } };
  }

  const user = await prisma.user.findUnique({ where: { email: session.user.email } });
  if (!user || (user.role !== "STAFF" && user.role !== "ADMIN")) {
    return { redirect: { destination: "/dashboard", permanent: false } };
  }

  const features = await prisma.feature.findMany({ orderBy: { createdAt: "desc" } });
  features.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);

  return {
    props: {
      userLabel: `${user.email} · Staff`,
      initialFeatures: features.map((f) => ({
        id: f.id,
        name: f.name,
        priority: f.priority,
        status: f.status,
        comment: f.comment,
        checked: f.checked,
        createdAt: f.createdAt.toISOString(),
        createdBy: f.createdBy,
      })),
    },
  };
};

export default function Roadmap({ userLabel, initialFeatures }: RoadmapProps) {
  const [features, setFeatures] = useState(initialFeatures);
  const [newName, setNewName] = useState("");
  const [newPriority, setNewPriority] = useState<Priority>("MEDIUM");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stats = {
    total: features.length,
    notStarted: features.filter((f) => f.status === "NOT_STARTED").length,
    inProgress: features.filter((f) => f.status === "IN_PROGRESS").length,
    implemented: features.filter((f) => f.status === "IMPLEMENTED").length,
  };

  async function updateFeature(id: string, updates: Partial<Feature>) {
    setError(null);
    try {
      const res = await fetch(`/api/features/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Update failed");
      const updated = await res.json();
      setFeatures((prev) => prev.map((f) => (f.id === id ? updated : f)));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function deleteFeature(id: string) {
    if (!window.confirm("Delete this feature?")) return;
    setError(null);
    try {
      const res = await fetch(`/api/features/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      setFeatures((prev) => prev.filter((f) => f.id !== id));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setAdding(true);
    setError(null);
    try {
      const res = await fetch("/api/features", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), priority: newPriority }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to add feature");
      const created = (await res.json()) as Feature;
      setFeatures((prev) => [created, ...prev].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]));
      setNewName("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="app-shell">
      <AppHeader active="dashboard" userLabel={userLabel} showPrintQueue showRoadmap />
      <main className="app-main">
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div>
            <div className="page-title">Feature Roadmap</div>
            <div className="page-subtitle">Internal tracker for planned improvements — staff only.</div>
          </div>

          <div style={{ display: "flex", gap: 16 }}>
            <MetricTile label="Total" value={String(stats.total)} tone="navy" />
            <MetricTile label="Not Started" value={String(stats.notStarted)} tone="teal" />
            <MetricTile label="In Progress" value={String(stats.inProgress)} tone="gold" />
            <MetricTile label="Implemented" value={String(stats.implemented)} tone="teal" />
          </div>

          <Card>
            <form onSubmit={handleAdd} style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
              <div className="field" style={{ flex: 1, minWidth: 200 }}>
                <label>Feature name</label>
                <input value={newName} onChange={(e) => setNewName(e.target.value)} />
              </div>
              <div className="field">
                <label>Priority</label>
                <select value={newPriority} onChange={(e) => setNewPriority(e.target.value as Priority)}>
                  <option value="HIGH">High</option>
                  <option value="MEDIUM">Medium</option>
                  <option value="LOW">Low</option>
                </select>
              </div>
              <button type="submit" className="btn btn-primary" disabled={adding}>
                {adding ? "Adding…" : "+ Add"}
              </button>
            </form>
            {error && (
              <div className="form-error" style={{ marginTop: 12 }}>
                {error}
              </div>
            )}
          </Card>

          <Card>
            {features.length === 0 ? (
              <div style={{ fontSize: 14, color: "var(--text-secondary)" }}>
                No features yet — add one above.
              </div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: 32 }}>Done</th>
                    <th>Feature</th>
                    <th>Priority</th>
                    <th>Status</th>
                    <th>Comment</th>
                    <th style={{ width: 32 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {features.map((f) => (
                    <tr key={f.id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={f.checked}
                          onChange={(e) => updateFeature(f.id, { checked: e.target.checked })}
                        />
                      </td>
                      <td>{f.name}</td>
                      <td>
                        <Badge tone={PRIORITY_TONE[f.priority]}>{f.priority}</Badge>
                      </td>
                      <td>
                        <select
                          value={f.status}
                          onChange={(e) => updateFeature(f.id, { status: e.target.value as Status })}
                        >
                          {Object.entries(STATUS_LABEL).map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <input
                          type="text"
                          defaultValue={f.comment ?? ""}
                          placeholder="Add note…"
                          onBlur={(e) => {
                            if (e.target.value !== (f.comment ?? "")) {
                              updateFeature(f.id, { comment: e.target.value || null });
                            }
                          }}
                        />
                      </td>
                      <td>
                        <button
                          onClick={() => deleteFeature(f.id)}
                          className="btn btn-secondary"
                          style={{ padding: "6px 10px" }}
                        >
                          🗑️
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>
      </main>
    </div>
  );
}
