export default function PriceTrendChart() {
  return (
    <div>
      <div className="mb-3 flex gap-4 text-xs text-ink/80">
        <span className="flex items-center gap-1.5">
          <i className="inline-block h-2.5 w-2.5 rounded-sm bg-accent" /> Your brand
        </span>
        <span className="flex items-center gap-1.5">
          <i className="inline-block h-2.5 w-2.5 rounded-sm bg-gold" /> Market average
        </span>
        <span className="flex items-center gap-1.5">
          <i className="inline-block h-2.5 w-2.5 rounded-sm bg-muted" /> Woolworths
        </span>
      </div>
      <svg viewBox="0 0 600 200" className="h-52 w-full" preserveAspectRatio="none">
        <line x1="0" y1="40" x2="600" y2="40" stroke="#dde1d8" strokeWidth="1" />
        <line x1="0" y1="90" x2="600" y2="90" stroke="#dde1d8" strokeWidth="1" />
        <line x1="0" y1="140" x2="600" y2="140" stroke="#dde1d8" strokeWidth="1" />
        <polyline
          points="0,120 60,118 120,110 180,112 240,95 300,100 360,88 420,92 480,80 540,84 600,76"
          fill="none"
          stroke="#6c7873"
          strokeWidth="2"
          strokeDasharray="3 4"
          opacity="0.8"
        />
        <polyline
          points="0,105 60,100 120,102 180,90 240,94 300,80 360,84 420,72 480,76 540,66 600,70"
          fill="none"
          stroke="#b9822c"
          strokeWidth="2.25"
        />
        <polyline
          points="0,130 60,125 120,128 180,116 240,120 300,104 360,108 420,90 480,96 540,82 600,88"
          fill="none"
          stroke="#1f6f5c"
          strokeWidth="2.75"
        />
        <circle cx="600" cy="88" r="4.5" fill="#1f6f5c" />
      </svg>
      <div className="mt-1.5 flex justify-between text-[0.68rem] text-muted">
        <span>29 Jun</span>
        <span>13 Jul</span>
        <span>28 Jul</span>
      </div>
    </div>
  );
}
