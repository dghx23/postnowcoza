const retailers = ["Checkers", "Woolworths", "Pick n Pay", "Shoprite", "SPAR", "Dis-Chem", "Clicks"];

const features = [
  {
    title: "Live price intelligence",
    body: "Daily scrapes across 7 retailers. See exactly who is undercutting you, by how much, and since when.",
  },
  {
    title: "Macro dashboard",
    body: "Inflation, fuel prices, and interest rates, overlaid directly against your category's performance.",
  },
  {
    title: "Buying power index",
    body: "Our proprietary metric shows whether your target consumer's real disposable income supports your current price.",
  },
];

const steps = [
  { num: "01", title: "Connect", body: "Tell us your SKUs — we start scraping them across every tracked retailer within 24 hours." },
  { num: "02", title: "Monitor", body: "Get alerted the moment a competitor moves, or a macro shift changes what your consumer can afford." },
  { num: "03", title: "Act", body: "Simulate a price change against real competitor data and current buying power before you commit." },
];

const plans = [
  {
    tier: "Starter",
    price: "R3,500",
    items: ["1 user · 50 SKUs", "30-day price history", "Basic dashboard + alerts", "CPI-only macro data"],
    cta: "Start free trial",
    featured: false,
  },
  {
    tier: "Professional",
    price: "R6,500",
    items: ["5 users · 250 SKUs", "90-day price history", "Gap analysis + price simulator", "Full macro + buying power index"],
    cta: "Start free trial",
    featured: true,
  },
  {
    tier: "Enterprise",
    price: "R12,500",
    items: ["Unlimited users · 1000+ SKUs", "365-day price history", "API access + white-label", "Real-time macro alerts"],
    cta: "Talk to sales",
    featured: false,
  },
];

export default function LandingPage() {
  return (
    <main className="bg-paper text-ink">
      <nav className="sticky top-0 z-10 border-b border-line bg-paper/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1140px] items-center justify-between px-7 py-4">
          <div className="flex items-center gap-2.5 font-bold">
            <span className="inline-block h-5.5 w-5.5 rounded bg-gradient-to-br from-accent to-gold" />
            MarketScope
          </div>
          <div className="hidden gap-8 text-sm text-ink/80 md:flex">
            <a href="#features">Features</a>
            <a href="#how">How it works</a>
            <a href="#pricing">Pricing</a>
            <a href="#contact">Contact</a>
          </div>
          <a href="/dashboard" className="rounded-md border border-line px-4 py-2 text-sm font-semibold">
            Login
          </a>
        </div>
      </nav>

      <header className="relative mx-auto max-w-[1140px] px-7 py-24 md:py-32">
        <div className="grid gap-16 md:grid-cols-[1.15fr_0.85fr] md:items-end">
          <div className="space-y-8">
            <div className="inline-block">
              <div className="mb-3 flex items-center gap-2.5 text-xs font-semibold uppercase tracking-widest text-accent">
                <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                Real-time market intel
              </div>
            </div>
            <div className="space-y-4">
              <h1 className="font-display text-6xl font-bold leading-[1.1] tracking-tighter">
                See the whole market.
                <span className="block bg-gradient-to-r from-accent to-gold bg-clip-text text-transparent">
                  Act with certainty.
                </span>
              </h1>
              <p className="max-w-[500px] text-lg leading-relaxed text-ink/70">
                Track prices across 7 retailers, overlay macro trends, and measure consumer buying power—all the context you need to price confidently.
              </p>
            </div>
            <div className="flex flex-wrap gap-4 pt-2">
              <a href="/dashboard" className="group relative inline-flex items-center rounded-lg bg-ink px-6 py-3.5 text-sm font-semibold text-paper transition-all hover:shadow-lg hover:shadow-ink/20">
                Start free trial
                <span className="ml-2 transition-transform group-hover:translate-x-0.5">→</span>
              </a>
              <a href="#contact" className="rounded-lg border border-line px-6 py-3.5 text-sm font-semibold transition-colors hover:bg-paper">
                Book a demo
              </a>
            </div>
            <p className="text-xs text-muted">No credit card needed · 14-day trial · Cancel anytime</p>
          </div>

          <div className="relative">
            <div className="absolute -inset-4 rounded-3xl bg-gradient-to-br from-accent/5 to-gold/5 blur-2xl" />
            <div className="relative rounded-2xl border border-line/50 bg-gradient-to-br from-white via-white to-paper p-6 shadow-xl shadow-ink/10 backdrop-blur-sm">
              <div className="mb-6 flex items-end justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-widest text-muted">Buying power index</p>
                  <p className="font-display mt-2 text-5xl font-bold text-ink">62.4</p>
                </div>
                <div className="text-right text-xs text-muted/60">↓ 3.2 pts / qtr</div>
              </div>

              <div className="mb-6 grid grid-cols-3 gap-3">
                <div className="rounded-xl bg-gradient-to-br from-accent/10 to-accent/5 p-3 ring-1 ring-accent/20">
                  <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-ink/70">Price gap</p>
                  <p className="font-display mt-1.5 text-xl font-bold text-ink">2.3%</p>
                </div>
                <div className="rounded-xl bg-gradient-to-br from-gold/10 to-gold/5 p-3 ring-1 ring-gold/20">
                  <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-ink/70">CPI (YoY)</p>
                  <p className="font-display mt-1.5 text-xl font-bold text-ink">6.1%</p>
                </div>
                <div className="rounded-xl bg-gradient-to-br from-line/50 to-line/25 p-3 ring-1 ring-line/30">
                  <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-ink/70">SKUs</p>
                  <p className="font-display mt-1.5 text-xl font-bold text-ink">84</p>
                </div>
              </div>

              <svg viewBox="0 0 280 60" className="mb-5 h-16 w-full" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="grad1" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stopColor="#1f6f5c" stopOpacity="0.3" />
                    <stop offset="100%" stopColor="#1f6f5c" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <polyline
                  points="0,45 35,42 70,35 105,38 140,25 175,30 210,18 245,15 280,10"
                  fill="none"
                  stroke="#1f6f5c"
                  strokeWidth="2.5"
                />
                <polyline
                  points="0,45 35,42 70,35 105,38 140,25 175,30 210,18 245,15 280,10"
                  fill="url(#grad1)"
                  strokeWidth="0"
                />
                <circle cx="280" cy="10" r="3" fill="#1f6f5c" />
              </svg>

              <div className="flex gap-3.5 border-t border-line/30 pt-4 text-[0.7rem] text-ink/60">
                <span className="flex items-center gap-1.5">
                  <i className="inline-block h-1.5 w-1.5 rounded-full bg-accent" /> Your brand
                </span>
                <span className="flex items-center gap-1.5">
                  <i className="inline-block h-1.5 w-1.5 rounded-full bg-gold" /> Market avg
                </span>
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="border-y border-line py-10">
        <div className="mx-auto flex max-w-[1140px] flex-wrap items-center gap-10 px-7">
          <span className="whitespace-nowrap text-[0.7rem] uppercase tracking-wide text-muted">
            Supported retailers
          </span>
          <div className="font-display flex flex-wrap gap-7 font-bold text-ink/80">
            {retailers.map((r) => (
              <span key={r} className="opacity-85">
                {r}
              </span>
            ))}
          </div>
        </div>
      </div>

      <section id="features" className="relative py-24 md:py-32">
        <div className="absolute inset-0 bg-gradient-to-b from-paper via-transparent to-transparent" />
        <div className="relative mx-auto max-w-[1140px] px-7">
          <div className="mb-16 max-w-[600px]">
            <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-accent">Core capabilities</p>
            <h2 className="font-display text-5xl font-bold leading-tight">
              One dashboard,
              <br />
              <span className="bg-gradient-to-r from-ink to-ink/60 bg-clip-text text-transparent">
                three perspectives.
              </span>
            </h2>
            <p className="mt-4 max-w-[520px] text-base leading-relaxed text-ink/70">
              Stop spreadsheet juggling. Prices, macroeconomics, and consumer behavior converge in context you can act on.
            </p>
          </div>

          <div className="grid gap-6 md:grid-cols-3 md:gap-8">
            {features.map((f, i) => (
              <div
                key={f.title}
                className={`group relative rounded-2xl border transition-all duration-300 hover:shadow-lg ${
                  i === 0
                    ? "border-accent/20 bg-gradient-to-br from-accent/5 via-white to-white hover:shadow-accent/10"
                    : i === 1
                      ? "border-gold/20 bg-gradient-to-br from-gold/5 via-white to-white hover:shadow-gold/10"
                      : "border-rust/20 bg-gradient-to-br from-rust/5 via-white to-white hover:shadow-rust/10"
                } p-8`}
              >
                <div className="mb-5 inline-flex h-12 w-12 items-center justify-center rounded-xl ring-1">
                  <div
                    className={`flex h-3 w-3 rounded-full ${
                      i === 0 ? "bg-accent ring-accent/30" : i === 1 ? "bg-gold ring-gold/30" : "bg-rust ring-rust/30"
                    }`}
                  />
                </div>
                <h3 className="font-display mb-3 text-xl font-bold tracking-tight">{f.title}</h3>
                <p className="leading-relaxed text-ink/70">{f.body}</p>
                <div className={`mt-6 h-0.5 w-0 bg-gradient-to-r ${i === 0 ? "from-accent" : i === 1 ? "from-gold" : "from-rust"} transition-all group-hover:w-8`} />
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="how" className="pb-22">
        <div className="mx-auto max-w-[1140px] px-7">
          <div className="mb-11 max-w-[560px]">
            <p className="mb-2.5 text-xs font-bold uppercase tracking-wide text-muted">How it works</p>
            <h2 className="font-display text-4xl font-bold">Three steps to a sharper price.</h2>
          </div>
          <div className="grid divide-y divide-line overflow-hidden rounded-xl border border-line bg-white md:grid-cols-3 md:divide-x md:divide-y-0">
            {steps.map((s) => (
              <div key={s.num} className="p-7">
                <p className="mb-3 text-xs font-bold text-accent">{s.num}</p>
                <h4 className="mb-2 font-semibold">{s.title}</h4>
                <p className="text-sm leading-relaxed text-ink/80">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="pricing" className="relative py-24 md:py-32">
        <div className="mx-auto max-w-[1140px] px-7">
          <div className="mx-auto mb-16 max-w-[580px] text-center">
            <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-accent">Simple pricing</p>
            <h2 className="font-display text-5xl font-bold leading-tight">
              Pick the plan
              <br />
              <span className="bg-gradient-to-r from-ink to-ink/60 bg-clip-text text-transparent">
                that fits your scale.
              </span>
            </h2>
            <p className="mt-4 text-base text-ink/70">All plans include free 14-day trial. No credit card required.</p>
          </div>

          <div className="grid gap-6 md:grid-cols-3 md:gap-8">
            {plans.map((p, idx) => (
              <div
                key={p.tier}
                className={`group relative flex flex-col overflow-hidden rounded-2xl transition-all duration-300 ${
                  p.featured
                    ? "md:scale-105 md:shadow-2xl md:shadow-accent/20"
                    : "hover:shadow-lg hover:shadow-ink/5"
                }`}
              >
                {p.featured && (
                  <>
                    <div className="absolute inset-0 bg-gradient-to-br from-accent via-accent/80 to-[#14493c]" />
                    <div className="absolute -right-20 -top-20 h-40 w-40 rounded-full bg-white/10 blur-3xl" />
                  </>
                )}

                <div className={`relative flex flex-col p-8 ${p.featured ? "text-white" : "bg-white"}`}>
                  {p.featured && (
                    <span className="mb-4 inline-block w-fit rounded-full bg-white/20 px-3 py-1 text-xs font-semibold uppercase tracking-wide backdrop-blur-sm">
                      Most popular
                    </span>
                  )}

                  <p className={`mb-2 text-xs font-semibold uppercase tracking-widest ${p.featured ? "text-white/80" : "text-muted"}`}>
                    {p.tier}
                  </p>

                  <div className="mb-8">
                    <p className={`font-display text-5xl font-bold tracking-tight ${p.featured ? "text-white" : "text-ink"}`}>
                      {p.price.replace("R", "")}
                    </p>
                    <p className={`text-sm ${p.featured ? "text-white/80" : "text-muted"}`}>/month</p>
                  </div>

                  <ul className="mb-8 flex flex-col gap-3.5">
                    {p.items.map((it) => (
                      <li key={it} className={`flex gap-3 text-sm leading-relaxed ${p.featured ? "text-white/90" : "text-ink/80"}`}>
                        <span className={`mt-0.5 flex h-4 w-4 items-center justify-center rounded-sm ${p.featured ? "bg-white/20" : "bg-accent/10"}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${p.featured ? "bg-white" : "bg-accent"}`} />
                        </span>
                        {it}
                      </li>
                    ))}
                  </ul>

                  <a
                    href="#contact"
                    className={`mt-auto rounded-lg px-5 py-3.5 text-center text-sm font-semibold transition-all ${
                      p.featured
                        ? "bg-white text-accent shadow-lg hover:shadow-xl hover:shadow-white/20"
                        : "border border-line bg-paper hover:bg-white"
                    }`}
                  >
                    {p.cta}
                  </a>
                </div>

                {!p.featured && <div className="h-px bg-gradient-to-r from-transparent via-line/30 to-transparent" />}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="contact" className="pb-22">
        <div className="mx-auto max-w-[1140px] px-7">
          <div className="rounded-2xl bg-gradient-to-br from-ink to-[#0c3b30] px-12 py-16 text-center text-[#f4f6f2]">
            <h2 className="font-display text-3xl font-bold">See where your prices actually stand.</h2>
            <p className="mt-3 text-[#f4f6f2]/80">
              Start a 14-day free trial — no credit card, no scraper to maintain, just the data.
            </p>
            <a href="/dashboard" className="mt-6 inline-block rounded-lg bg-white px-6 py-3 text-sm font-semibold text-ink">
              Start free trial
            </a>
          </div>
        </div>
      </section>

      <footer className="border-t border-line py-11">
        <div className="mx-auto flex max-w-[1140px] flex-wrap items-center justify-between gap-5 px-7 text-sm text-muted">
          <span>© 2026 MarketScope</span>
          <div className="flex gap-5">
            <a href="#">Privacy Policy</a>
            <a href="#">Terms</a>
            <a href="#contact">Contact</a>
          </div>
        </div>
      </footer>
    </main>
  );
}
