interface KpiCardProps {
  label: string;
  value: string;
  delta?: { text: string; tone: "up" | "down" | "warn" };
  accent?: boolean;
}

const deltaClasses: Record<string, string> = {
  up: "bg-rust/10 text-rust ring-1 ring-rust/20",
  down: "bg-accent/10 text-accent ring-1 ring-accent/20",
  warn: "bg-gold/10 text-gold ring-1 ring-gold/20",
};

export default function KpiCard({ label, value, delta, accent }: KpiCardProps) {
  return (
    <div
      className={`group relative overflow-hidden rounded-xl border p-5 transition-all duration-300 ${
        accent
          ? "border-accent/40 bg-gradient-to-br from-accent/15 via-accent/8 to-accent/4"
          : "border-line/50 bg-gradient-to-br from-white via-white to-paper/40 hover:shadow-lg hover:shadow-ink/5"
      }`}
    >
      {accent && <div className="absolute -right-16 -top-16 h-32 w-32 rounded-full bg-white/20 blur-3xl" />}

      <div className="relative space-y-3">
        <p className={`text-xs font-semibold uppercase tracking-widest ${accent ? "text-white/80" : "text-muted/80"}`}>
          {label}
        </p>
        <p className={`font-display text-3xl font-bold tabular-nums tracking-tight ${accent ? "text-white" : "text-ink"}`}>
          {value}
        </p>
        {delta && (
          <span className={`w-fit rounded-lg px-3 py-1.5 text-xs font-semibold ${accent ? "bg-white/20 text-white ring-1 ring-white/30" : deltaClasses[delta.tone]}`}>
            {delta.text}
          </span>
        )}
      </div>
    </div>
  );
}
