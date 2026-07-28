interface Row {
  name: string;
  pack: string;
  you: string;
  woolworths: string;
  picknpay: string;
  gap: string;
  gapUp: boolean;
}

const rows: Row[] = [
  { name: "Coca-Cola Original", pack: "2L PET", you: "R29.99", woolworths: "R27.99", picknpay: "R28.50", gap: "R2.00", gapUp: true },
  { name: "Coca-Cola Zero Sugar", pack: "1.5L PET", you: "R24.50", woolworths: "R25.99", picknpay: "R24.99", gap: "R0.49", gapUp: false },
  { name: "Sprite", pack: "2L PET", you: "R28.99", woolworths: "R28.99", picknpay: "R27.00", gap: "R1.99", gapUp: true },
  { name: "Fanta Orange", pack: "2L PET", you: "R27.50", woolworths: "R29.00", picknpay: "R28.99", gap: "R1.49", gapUp: false },
  { name: "Powerade Blue", pack: "500ml", you: "R18.99", woolworths: "R19.99", picknpay: "R18.50", gap: "R0.49", gapUp: true },
];

export default function PriceGapTable() {
  return (
    <div className="overflow-hidden rounded-2xl border border-line/50 bg-gradient-to-br from-white via-white to-paper/30 shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="bg-gradient-to-r from-paper/50 to-transparent [&>th]:px-5 [&>th]:py-4 [&>th]:text-left [&>th]:text-xs [&>th]:font-semibold [&>th]:uppercase [&>th]:tracking-widest [&>th]:text-muted [&>th]:border-b [&>th]:border-line/30">
              <th>Product</th>
              <th className="text-right">Your price</th>
              <th className="text-right">Woolworths</th>
              <th className="text-right">Pick n Pay</th>
              <th className="text-right">Gap vs. avg</th>
              <th className="text-right">Trend</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr
                key={r.name}
                className={`group border-b border-line/20 transition-colors hover:bg-paper/50 [&>td]:py-4 [&>td]:px-5 last:[&>td]:border-none ${
                  idx === 0 ? "bg-gradient-to-r from-accent/3 to-transparent" : ""
                }`}
              >
                <td>
                  <div className="flex flex-col gap-0.5">
                    <span className="font-semibold text-ink">{r.name}</span>
                    <span className="text-xs text-muted/70">{r.pack}</span>
                  </div>
                </td>
                <td className="text-right font-bold tabular-nums text-ink">{r.you}</td>
                <td className="text-right tabular-nums text-ink/80">{r.woolworths}</td>
                <td className="text-right tabular-nums text-ink/80">{r.picknpay}</td>
                <td className="text-right">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold ring-1 ${
                      r.gapUp
                        ? "bg-rust/10 text-rust ring-rust/20"
                        : "bg-accent/10 text-accent ring-accent/20"
                    }`}
                  >
                    <span className={`text-lg leading-none ${r.gapUp ? "text-rust" : "text-accent"}`}>
                      {r.gapUp ? "↑" : "↓"}
                    </span>
                    {r.gap}
                  </span>
                </td>
                <td className="text-right text-muted/50">—</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
