export default function BuyingPowerPanel() {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-line/50 bg-gradient-to-br from-white via-white to-paper/40 p-6 shadow-sm">
      <div className="absolute -right-20 -top-20 h-40 w-40 rounded-full bg-gradient-to-br from-gold/10 to-transparent blur-3xl" />

      <div className="relative">
        <h3 className="font-display text-lg font-bold text-ink">Buying power</h3>

        <div className="mt-6 flex flex-col items-center">
          <div className="relative h-24 w-24">
            <svg width="100%" height="100%" viewBox="0 0 150 90" style={{ maxWidth: "100%", height: "auto" }}>
              <defs>
                <linearGradient id="gaugeGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#b9822c" stopOpacity="0.2" />
                  <stop offset="100%" stopColor="#b9822c" stopOpacity="0.5" />
                </linearGradient>
              </defs>
              <path d="M10 85 A65 65 0 0 1 140 85" fill="none" stroke="#dde1d8" strokeWidth="10" strokeLinecap="round" />
              <path d="M10 85 A65 65 0 0 1 96 21" fill="url(#gaugeGrad)" stroke="#b9822c" strokeWidth="10" strokeLinecap="round" />
              <line x1="75" y1="85" x2="98" y2="34" stroke="#172127" strokeWidth="2.5" strokeLinecap="round" />
              <circle cx="75" cy="85" r="5" fill="#172127" />
            </svg>
          </div>

          <p className="font-display -mt-3 text-4xl font-bold tabular-nums text-ink">62.4</p>
          <p className="mt-2 max-w-[240px] text-center text-sm leading-relaxed text-ink/75">
            Consumer purchasing power tightening. Promotions {'>'}price increases.
          </p>
          <p className="mt-3 text-xs text-muted">↓ 3.2 pts vs. last quarter</p>
        </div>

        <div className="mt-7 space-y-4 border-t border-line/30 pt-5">
          <div className="group flex gap-3 rounded-lg border border-gold/10 bg-gradient-to-r from-gold/5 to-transparent p-4 transition-colors hover:border-gold/20 hover:bg-gold/8">
            <span className="h-fit rounded-lg bg-gradient-to-br from-gold to-gold/80 px-2 py-1 text-[0.65rem] font-bold uppercase tracking-wide text-white">
              Fuel
            </span>
            <div className="flex-1">
              <p className="text-sm font-medium text-ink">Petrol +12¢/L effective today</p>
              <p className="mt-1 text-xs text-ink/65">Landed cost impact: +0.5%</p>
            </div>
          </div>

          <div className="group flex gap-3 rounded-lg border border-accent/10 bg-gradient-to-r from-accent/5 to-transparent p-4 transition-colors hover:border-accent/20 hover:bg-accent/8">
            <span className="h-fit rounded-lg bg-gradient-to-br from-accent to-accent/80 px-2 py-1 text-[0.65rem] font-bold uppercase tracking-wide text-white">
              Rates
            </span>
            <div className="flex-1">
              <p className="text-sm font-medium text-ink">SARB holds repo at 8.25%</p>
              <p className="mt-1 text-xs text-ink/65">Tight credit limits premium demand</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
