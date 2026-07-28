import KpiCard from "../components/KpiCard";
import PriceTrendChart from "../components/PriceTrendChart";
import BuyingPowerPanel from "../components/BuyingPowerPanel";
import PriceGapTable from "../components/PriceGapTable";

export default function DashboardPage() {
  return (
    <main className="min-h-screen bg-paper text-ink">
      <header className="sticky top-0 z-10 border-b border-line/40 bg-gradient-to-b from-white via-white to-white/80 backdrop-blur-sm px-7 py-4">
        <div className="mx-auto max-w-[1180px] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-accent via-accent to-gold">
              <span className="font-display text-sm font-bold text-white">M</span>
            </div>
            <span className="font-display text-lg font-bold">MarketScope</span>
          </div>
          <div className="flex items-center gap-4">
            <div className="hidden sm:block rounded-lg border border-line/60 bg-paper/40 px-4 py-2.5 text-sm font-medium text-ink/80 transition-colors hover:bg-paper/60">
              Last 30 days ▾
            </div>
            <button
              type="button"
              aria-label="Notifications"
              className="group relative flex h-9 w-9 items-center justify-center rounded-full border border-line/60 text-base transition-all hover:border-line hover:bg-paper/60"
            >
              🔔
              <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-white bg-rust shadow-sm" />
            </button>
            <div className="flex h-9 w-9 items-center justify-center rounded-full border border-accent/30 bg-gradient-to-br from-accent/20 to-accent/10 text-xs font-bold text-accent">
              HB
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1180px] px-7 py-12">
        <div className="mb-8">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted/80">
            Dashboard — Coca-Cola Beverages SA
          </p>
          <div className="mt-2 flex items-center justify-between">
            <div>
              <h2 className="font-display text-2xl font-bold">84 SKUs tracked</h2>
              <p className="mt-1 text-sm text-ink/60">Monitoring real-time pricing across 7 retailers</p>
            </div>
          </div>
        </div>

        <section className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:gap-5 xl:grid-cols-6 xl:gap-4">
          <KpiCard label="Avg. price position" value="2.3" delta={{ text: "of 4 retailers", tone: "warn" }} />
          <KpiCard label="Products tracked" value="84" delta={{ text: "↑ 6 this month", tone: "down" }} />
          <KpiCard label="Price drops detected" value="11" delta={{ text: "last 7 days", tone: "up" }} />
          <KpiCard label="Savings at risk" value="R14.2k" delta={{ text: "↑ margin exposure", tone: "up" }} />
          <KpiCard label="CPI impact (YoY)" value="6.1%" delta={{ text: "above target", tone: "warn" }} />
          <KpiCard label="Buying power index" value="62.4" delta={{ text: "↓ 3.2 pts / qtr", tone: "down" }} accent />
        </section>

        <section className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[1.6fr_1fr]">
          <div className="rounded-2xl border border-line/50 bg-gradient-to-br from-white via-white to-paper/30 p-6 shadow-sm">
            <div className="mb-5 flex items-center justify-between">
              <h3 className="font-display text-lg font-bold">Price trends</h3>
              <div className="flex gap-1 rounded-lg border border-line/50 bg-paper/50 p-1">
                <span className="rounded-md bg-white px-3 py-1.5 text-xs font-semibold shadow-sm transition-all">
                  Price trends
                </span>
                <span className="px-3 py-1.5 text-xs font-medium text-muted/70 transition-all hover:text-ink/70 cursor-pointer">
                  Macro overlay
                </span>
              </div>
            </div>
            <PriceTrendChart />
          </div>
          <BuyingPowerPanel />
        </section>

        <div className="mt-8">
          <div className="mb-5">
            <h3 className="font-display text-lg font-bold">Price gaps</h3>
            <p className="mt-1 text-sm text-ink/60">vs. tracked retailers</p>
          </div>
          <PriceGapTable />
        </div>

        <div className="mt-8 rounded-2xl border border-line/20 bg-gradient-to-r from-accent/5 to-gold/5 px-6 py-5 text-center">
          <p className="text-xs font-medium text-ink/70">
            <span className="font-semibold">Mock data preview</span> — Real retailer prices and macro feeds will populate once scrapers are live.
          </p>
        </div>
      </div>
    </main>
  );
}
