'use client';

import { useState, useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import s from '../landing.module.css';
import ModelAccuracyStats from './ModelAccuracyStats';

const CODE_SNIPPET = `{
  "success": true,
  "timestamp": "2026-05-11T06:00:00Z",
  "source": "livedata",
  "stocks": [
    {
      "ticker": "NVDA",
      "gps_score": 92,
      "ml_prediction_1m": "+7.5%",
      "regime": "Risk-On"
    }
  ],
  "hot_etfs": [
    {
      "ticker": "SMH",
      "theme": "Semiconductors",
      "macro_tailwind": 88.4
    }
  ],
  "macro_context": {
    "global_health": 74.2,
    "unemployment_signal": "bullish",
    "regime": "Risk-On"
  }
}`;

export default function LandingPage() {
  const { status } = useSession();
  const router = useRouter();
  const [navOpen, setNavOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (status === 'authenticated') {
      router.push('/dashboard');
    }
  }, [status, router]);

  if (status === 'authenticated') return null;

  const handleCopy = () => {
    navigator.clipboard.writeText(CODE_SNIPPET).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };

  return (
    <div className={s.page}>
      <a href="#main-content" className={s.skipLink}>Skip to main content</a>

      {/* ── NAV ── */}
      <header className={s.nav}>
        <div className={s.navInner}>
          <a href="#hero" className={s.navLogo}>
            <span className={s.logoMark}>▲</span>
            <span>GrowMyStocks</span>
          </a>
          <nav
            className={`${s.navLinks} ${navOpen ? s.navLinksOpen : ''}`}
            id="navLinks"
            aria-label="Main navigation"
          >
            <a href="#features">Features</a>
            <a href="#how-it-works">How It Works</a>
            <a href="#prediction">AI Prediction</a>
            <a href="#deep-money">DeepMoney</a>
            <Link href="/login">Log In</Link>
            <Link href="/register" className={s.navCta}>Register an Account</Link>
          </nav>
          <button
            className={s.hamburger}
            aria-label="Toggle navigation menu"
            aria-expanded={navOpen}
            aria-controls="navLinks"
            onClick={() => setNavOpen(v => !v)}
          >
            <span /><span /><span />
          </button>
        </div>
      </header>

      <main id="main-content">

        {/* ── HERO ── */}
        <section className={s.hero} id="hero">
          <div className={s.heroBgGrid} aria-hidden="true" />
          <div className={s.heroGlow1} aria-hidden="true" />
          <div className={s.heroGlow2} aria-hidden="true" />
          <div className={s.heroInner}>
            <div className={s.heroContent}>
              <div className={s.heroBadge}>
                <span className={s.badgeDot} aria-hidden="true" />
                DeepMoney &middot; AI Prediction Engine v3.1
              </div>
              <h1 className={s.heroHeadline}>
                <span className={s.headlineSerif}>AI-Powered</span><br />
                Market Intelligence<br />
                <span className={s.headlineAccent}>&amp; Deep Money Discovery</span>
              </h1>
              <p className={s.heroSub}>
                Surface high-potential stocks and ETFs using machine learning, macro data, and real-time market signals — before the crowd finds them.
              </p>
              <div className={s.heroActions}>
                <Link href="/register" className={s.btnPrimary}>Register an Account</Link>
                <a href="#how-it-works" className={s.btnGhost}>See How It Works <span aria-hidden="true">→</span></a>
              </div>
              <div className={s.heroStats}>
                <div className={s.stat}>
                  <span className={s.statVal}>109+</span>
                  <span className={s.statLabel}>Feature Tensor</span>
                </div>
                <div className={s.statDivider} aria-hidden="true" />
                <div className={s.stat}>
                  <span className={s.statVal}>v3.1</span>
                  <span className={s.statLabel}>Prediction Engine</span>
                </div>
                <div className={s.statDivider} aria-hidden="true" />
                <div className={s.stat}>
                  <span className={s.statVal}>3</span>
                  <span className={s.statLabel}>Recommendation Buckets</span>
                </div>
                <div className={s.statDivider} aria-hidden="true" />
                <div className={s.stat}>
                  <span className={s.statVal}>5yr</span>
                  <span className={s.statLabel}>Historical Dataset</span>
                </div>
              </div>
            </div>

            <div className={s.heroVisual} aria-hidden="true">
              <div className={s.dashboardMock}>
                <div className={s.mockHeader}>
                  <div className={s.mockDots}>
                    <span className="bg-[#ff5f57]" />
                    <span className="bg-[#febc2e]" />
                    <span className="bg-[#28c840]" />
                  </div>
                  <span className={s.mockTitle}>GrowMyStocks Dashboard</span>
                </div>
                <div className={s.mockBody}>
                  <div className={s.mockSectionLabel}>AI Discovery · GPS Score</div>
                  {[
                    { t: 'NVDA', w: '92%', score: 92, cls: s.gpsHigh },
                    { t: 'PLTR', w: '87%', score: 87, cls: s.gpsHigh },
                    { t: 'ANET', w: '81%', score: 81, cls: s.gpsMid  },
                    { t: 'SMH',  w: '78%', score: 78, cls: s.gpsMid  },
                  ].map(({ t, w, score, cls }) => (
                    <div key={t} className={s.mockStockRow}>
                      <div className={s.mockTicker}>{t}</div>
                      <div className={s.mockBarWrap}><div className={s.mockBar} style={{ width: w }} /></div>
                      <div className={`${s.mockScore} ${cls}`}>{score}</div>
                    </div>
                  ))}
                  <div className={s.mockDivider} />
                  <div className={s.mockSectionLabel}>AI Prediction · 1-Month Target</div>
                  {[
                    { t: 'NVDA', cur: '$875.20', tgt: '$941.00', pct: '+7.5%' },
                    { t: 'PLTR', cur: '$24.80',  tgt: '$27.20',  pct: '+9.7%' },
                  ].map(({ t, cur, tgt, pct }) => (
                    <div key={t} className={s.mockPredRow}>
                      <span className={s.mockPredTicker}>{t}</span>
                      <span className={s.mockPredCurrent}>{cur}</span>
                      <span className={s.mockPredArrow}>→</span>
                      <span className={s.mockPredTarget}>{tgt}</span>
                      <span className={s.mockPredUp}>{pct}</span>
                    </div>
                  ))}
                  <div className={s.mockMacro}>
                    <span className={s.macroLabel}>Global Health Score</span>
                    <span className={s.macroVal}>74.2</span>
                    <span className={s.macroBullish}>● Bullish</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── FEATURES / 3-BUCKET ── */}
        <section className={s.features} id="features">
          <div className={s.container}>
            <div className={s.sectionHeader}>
              <span className={s.sectionTag}>Core Intelligence</span>
              <h2>Three Signals. One Dashboard.</h2>
              <p>GrowMyStocks surfaces AI-driven opportunities across three recommendation buckets — tailored to where you already are in the market.</p>
            </div>
            <div className={s.buckets}>
              <div className={s.bucket}>
                <span className={s.bucketIcon} aria-hidden="true">📊</span>
                <h3>Portfolio</h3>
                <p>AI price targets compared against your actual cost basis. Know when to hold, add, or trim with precision — not guesswork.</p>
                <ul>
                  <li>Real-time P&amp;L tracking</li>
                  <li>AI price target vs. cost basis</li>
                  <li>Account trajectory charting</li>
                </ul>
              </div>
              <div className={s.bucket}>
                <span className={s.bucketIcon} aria-hidden="true">👁</span>
                <h3>Watchlist</h3>
                <p>Breakout monitoring for tickers you&apos;ve already identified. Get alerted when AI confirms momentum on your confirmed interests.</p>
                <ul>
                  <li>Breakout pattern detection</li>
                  <li>Technical &amp; analyst signal fusion</li>
                  <li>Regime-adjusted alerts</li>
                </ul>
              </div>
              <div className={s.bucket}>
                <span className={s.bucketIcon} aria-hidden="true">🔭</span>
                <h3>Discovery</h3>
                <p>High-GPS opportunities surfaced daily from the DeepMoney sync cycle — stocks and ETFs you haven&apos;t found yet, but should.</p>
                <ul>
                  <li>DeepMoney powered</li>
                  <li>ML validation gate (≥1.5% threshold)</li>
                  <li>Macro tailwind scoring</li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* ── HOW IT WORKS ── */}
        <section className={s.howItWorks} id="how-it-works">
          <div className={s.container}>
            <div className={s.sectionHeader}>
              <span className={s.sectionTag}>The Engine</span>
              <h2>DeepMoney — How Discovery Works</h2>
              <p>A multi-stage background process that updates AI recommendations, ETF scoring, and global risk indices every day.</p>
            </div>
            <div className={s.steps}>
              {[
                {
                  num: '01', title: 'Macro Data Sync',
                  body: 'Fetches high-fidelity macroeconomic indicators from the World Bank API — GDP Growth, Inflation, FDI, Trade Volume, and Tech Adoption across USA, GBR, CHN, IND, and DEU. Computes a daily Global Health Score snapshot.',
                },
                {
                  num: '02', title: 'Recursive News Discovery',
                  body: 'Scrapes global financial RSS feeds and scans for co-mentioned peers. Stocks and ETFs surface through thematic signal — AI, Semis, Cloud, and Cybersecurity mapping — with liquidity gates (>50k volume, >$50M AUM).',
                },
                {
                  num: '03', title: 'ML Validation Gate',
                  body: 'Every candidate must pass a sequential 1-month ML prediction with a minimum ≥ 1.5% expected growth threshold. Candidates are filtered through market regime context and World Bank consumption multipliers.',
                },
                {
                  num: '04', title: 'GPS Scoring & Persistence',
                  body: 'Validated stocks are scored on a 100-point GPS scale — 19% weights each for fundamentals and ML upside — then committed to the dashboard. Hot ETFs are upserted with macro tailwind scores alongside recommended stocks.',
                },
              ].map((step, i, arr) => (
                <div key={step.num}>
                  <div className={s.step}>
                    <div className={s.stepNum}>{step.num}</div>
                    <div className={s.stepBody}>
                      <h3>{step.title}</h3>
                      <p>{step.body}</p>
                    </div>
                  </div>
                  {i < arr.length - 1 && <div className={s.stepConnector} aria-hidden="true" />}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── MODEL ACCURACY ── */}
        <ModelAccuracyStats variant="section" />

        {/* ── AI PREDICTION ENGINE ── */}
        <section className={s.prediction} id="prediction">
          <div className={s.container}>
            <div className={s.predictionGrid}>
              <div className={s.predictionLeft}>
                <span className={`${s.sectionTag} ${s.sectionTagLight}`}>AI Prediction Engine v3.1</span>
                <h2>Multi-Horizon Price Targets Powered by 109+ Features</h2>
                <p>A fresh MLP model trains on 45-day sequences every time a prediction runs — incorporating data your brokerage app will never show you.</p>
                <div className={s.predHorizons}>
                  {[
                    { label: '1 Day',    desc: 'Short-term signal with MC dropout confidence interval' },
                    { label: '1 Month',  desc: 'Core target used in ML validation gate' },
                    { label: '6 Month',  desc: 'Macro-adjusted medium-term projection' },
                    { label: '1 Year',   desc: 'Long-range with regime & analyst consensus weighting' },
                  ].map(({ label, desc }) => (
                    <div key={label} className={s.horizon}>
                      <span className={s.horizonLabel}>{label}</span>
                      <span className={s.horizonDesc}>{desc}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className={s.featureTensor}>
                <div className={s.tensorTitle}>109+ Column Feature Tensor</div>
                {[
                  { group: 'Price & Momentum',    tags: ['Close_lag_5', 'ROC_5d', 'Return_1d', 'EMA_Slope_10', 'PriceToHigh_20d'] },
                  { group: 'Rolling Statistics',  tags: ['RollingMean_20d', 'RollingStd_20d', 'Skewness', 'SharpeRatio'] },
                  { group: 'Macro & Credit',      tags: ['WorldBank_GDP', 'Inflation', 'HYG_LQD_Spread', 'DXY_Index', 'VIX_Proxy'] },
                  { group: 'Regime & Options',    tags: ['GMM_Regime', 'Regime_x_PC_Ratio', 'IV_Rank', 'Put_Call_Ratio'] },
                  { group: 'Fundamentals',        tags: ['Earnings_Surprise', 'Short_Interest', 'Analyst_Target', 'FDI_Signal'] },
                ].map(({ group, tags }) => (
                  <div key={group} className={s.tensorGroup}>
                    <div className={s.tensorGroupLabel}>{group}</div>
                    <div className={s.tensorTags}>
                      {tags.map(t => <span key={t} className={s.tensorTag}>{t}</span>)}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className={s.archRow}>
              {[
                { icon: '🧠', title: 'MLP Architecture',       desc: '256 → 128 → 64 → 32 (ReLU + Dropout)' },
                { icon: '🎲', title: 'Monte Carlo Inference',  desc: '30× dropout passes · per-feature noise scaling' },
                { icon: '📡', title: 'Regime Detection',       desc: 'GMM clustering on VIX & Credit Spreads' },
                { icon: '🌍', title: 'Macro Dampeners',        desc: 'Unemployment & Global Health Score modifiers' },
              ].map(({ icon, title, desc }) => (
                <div key={title} className={s.archPill}>
                  <span className={s.archIcon} aria-hidden="true">{icon}</span>
                  <div>
                    <strong>{title}</strong>
                    <span>{desc}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── DEEP MONEY ── */}
        <section className={s.deepMoney} id="deep-money">
          <div className={s.container}>
            <div className={s.sectionHeader}>
              <span className={s.sectionTag}>Infrastructure</span>
              <h2>What Runs Under the Hood</h2>
              <p>GrowMyStocks is built on a modern hybrid stack — Next.js frontend, Node.js API routes with Python ML spawning, and a MySQL data layer.</p>
            </div>
            <div className={s.infraCards}>
              {[
                { badge: 'Discovery', title: 'Recursive Co-Mention Analysis',   body: 'Global financial RSS feeds are scraped and cross-referenced. Stocks frequently co-mentioned with known leaders surface as candidates — a signal of emerging narrative momentum.' },
                { badge: 'Scoring',   title: 'v2.3 GPS Scale (100-point)',       body: 'Every discovery is scored across fundamentals (19%), ML upside (19%), macro tailwind, thematic alignment, liquidity, and technical momentum. Only top scorers reach the dashboard.' },
                { badge: 'ETFs',      title: 'Hot ETF Module',                   body: 'Identifies trending ETFs under $400/share with thematic alignment to AI, Semiconductors, Cloud, and Cybersecurity. Minimum liquidity gates: >50k daily volume and >$50M AUM.' },
                { badge: 'Data',      title: '5-Year Multi-Dimensional Dataset', body: '~1,260 rows of daily OHLCV data enriched with options flow (IV, PCR), World Bank macro indicators, VIX, Treasury yields, DXY, and Credit Spreads per ticker.' },
                { badge: 'Portfolio', title: 'Real-Time P&L & History',          body: 'Live market quotes feed portfolio performance tracking. Full account value trajectory charting helps you see not just where you are — but where you\'ve been.' },
                { badge: 'Access',    title: 'Registration Approval & Role Quotas', body: 'New accounts are vetted and activated by an admin before gaining access. Role-based quotas (User, Superuser, Admin) enforce limits on watchlist size, portfolio positions, and daily lookups.' },
              ].map(({ badge, title, body }) => (
                <div key={title} className={s.infraCard}>
                  <div className={s.infraBadge}>{badge}</div>
                  <h3>{title}</h3>
                  <p>{body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── API SNAPSHOT ── */}
        <section className={s.apiSnapshot} id="api">
          <div className={s.apiGrid}>
            <div className={s.apiLeft}>
              <span className={s.sectionTag}>Live Intelligence</span>
              <h2>Fresh Signals, Every Day</h2>
              <p>The DeepMoney sync pipeline runs daily — fetching macro data, triggering discovery, validating through ML, and committing enriched results to the dashboard before markets open.</p>
              <div className={s.apiEndpoints}>
                {[
                  { m: 'GET',  ep: '/api/stock_data/[ticker]' },
                  { m: 'POST', ep: '/api/prediction/[ticker]' },
                  { m: 'GET',  ep: '/api/worldbank' },
                  { m: 'GET',  ep: '/api/dashboard' },
                  { m: 'GET',  ep: '/api/prediction/deepmoney' },
                ].map(({ m, ep }) => (
                  <div key={ep} className={s.endpoint}>
                    <span className={s.epMethod}>{m}</span>
                    <code>{ep}</code>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className={s.codeBlock}>
                <div className={s.codeHeader}>
                  <span className={s.codeLang}>JSON Response · DeepMoney Sync</span>
                  <button className={s.codeCopy} onClick={handleCopy} aria-label="Copy code snippet">
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <pre><code>{CODE_SNIPPET}</code></pre>
              </div>
            </div>
          </div>
        </section>

        {/* ── CTA ── */}
        <section className={s.cta} id="cta">
          <div className={s.ctaInner}>
            <h2>Ready to Invest with an Edge?</h2>
            <p>Join GrowMyStocks and get access to AI-powered GPS scores, multi-horizon price predictions, and portfolio analytics — all in one dashboard.</p>
            <div className={s.ctaActions}>
              <Link href="/register" className={s.btnPrimaryWhite}>Register an Account</Link>
              <Link href="/login" className={s.btnGhostWhite}>Sign In</Link>
            </div>
            <p className="mt-5 text-[0.8125rem] text-[#64748b] mb-0">
              Free to register &mdash; account access requires admin approval.
            </p>
          </div>
        </section>

      </main>

      {/* ── FOOTER ── */}
      <footer className={s.landingFooter}>
        <div className={s.landingFooterInner}>
          <nav className={s.footerLinks} aria-label="Footer navigation">
            <Link href="/legal/privacy">Privacy Policy</Link>
            <Link href="/legal/terms">Terms of Service</Link>
            <Link href="/legal/disclaimer">Disclaimer</Link>
            <Link href="/contact">Contact</Link>
            <Link href="/login">Log In</Link>
          </nav>
          <p className={s.footerCopy}>&copy; {new Date().getFullYear()} GrowMyStocks. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
}
