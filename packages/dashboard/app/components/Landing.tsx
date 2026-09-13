"use client";

// The landing page: a creative studio's moodboard for a payments product. One
// centered hero (badge, display headline with a highlighted word, subhead, CTA
// stack, backed-by strip), then sections that breathe at 80px: how a payment
// works, the sticky-note feature grid, the credit story with a mock passport,
// the connect block, the honesty note, a yellow closing band, a short footer.
// Everything here is real copy about the real product; nothing links to "#".

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion, type Variants } from "motion/react";
import { usePrivy } from "@privy-io/react-auth";
import { Logo } from "./Logo";
import { ThemeToggle } from "./Theme";
import { SketchArrow, SketchCircle, SketchLoop, SketchStar } from "./Sketch";

const rise: Variants = {
  hidden: { opacity: 0, y: 18 },
  show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] } },
};
const stagger: Variants = { hidden: {}, show: { transition: { staggerChildren: 0.08 } } };

/** The floating pill nav, shared by the landing page and the public pages. */
export function PublicNav({ links = true }: { links?: boolean }) {
  const path = usePathname();
  const { authenticated, ready } = usePrivy();
  const dash = ready && authenticated ? "Open dashboard" : "Sign in";
  return (
    <div className="lpnav-wrap">
      <nav className="lpnav" aria-label="Primary">
        <Logo href="/" />
        {links && (
          <div className="navlinks">
            <a className="navlink" href="/#how">
              How it works
            </a>
            <a className="navlink" href="/#features">
              Product
            </a>
            <a className="navlink" href="/#credit">
              Credit
            </a>
            <Link className={`navlink${path?.startsWith("/docs") ? " on" : ""}`} href="/docs">
              Docs
            </Link>
          </div>
        )}
        <div className="ctas">
          <ThemeToggle />
          <Link className="abtn outline" href="/docs">
            Docs
          </Link>
          <Link className="abtn primary arrow" href="/app" data-testid="landing-open">
            {dash}
          </Link>
        </div>
      </nav>
    </div>
  );
}

export function Landing() {
  return (
    <div className="lp">
      <PublicNav />

      {/* ---- hero ---- */}
      <header className="lphero lpwrap">
        <SketchArrow className="sk1" size={150} />
        <SketchStar className="sk2" size={70} />
        <SketchLoop className="sk3" size={170} />
        <SketchCircle className="sk4" size={100} />
        <motion.div variants={stagger} initial="hidden" animate="show">
          <motion.span className="lpbadge" variants={rise}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M9 1.5 3.5 9h4l-1 5.5L12 7H8z" />
            </svg>
            Agentic spending cards · live on Base
          </motion.span>
          <motion.h1 className="lph1" variants={rise}>
            Give your agent a <span className="hl wash">card</span>, not your keys.
          </motion.h1>
          <motion.p className="lpsub" variants={rise}>
            Issue a scoped, revocable spending card from your wallet. Any AI agent plugs it in over MCP and pays
            within your limits — no keys, no gas, dead the moment you revoke. Every payment is proven onto
            Creditcoin, building credit history the agent can borrow against.
          </motion.p>
          <motion.div className="lpctas" variants={rise}>
            <Link className="abtn primary big arrow" href="/app" data-testid="landing-cta">
              Issue a card
            </Link>
            <Link className="abtn pastel big" href="/docs">
              Read the docs
            </Link>
          </motion.div>
          <motion.p className="lpreassure" variants={rise}>
            sign in with email or Google · no seed phrase, no card on file.
          </motion.p>
          <motion.div className="lpbacked" variants={rise} aria-label="Built on">
            <span className="bl">Built on:</span>
            <span>Base</span>
            <span>ERC-7710</span>
            <span>EIP-7702</span>
            <span>x402</span>
            <span>Creditcoin</span>
            <span>Attestcoin</span>
            <span>MCP</span>
            <span>SigNoz</span>
          </motion.div>
        </motion.div>
      </header>

      {/* ---- how a payment works ---- */}
      <Section id="how" eyebrow="How a payment works" title={<>Three moves, and the agent never touches money.</>}>
        <div className="steps">
          {[
            {
              n: "01",
              t: "You issue",
              p: (
                <>
                  Set the terms — budget per period, per-payment cap, merchant allowlist, expiry — or draft them in
                  plain language. Your wallet <span className="hl">signs the delegation</span> in the browser; the
                  server stores it beside a fresh agent key that holds nothing.
                </>
              ),
            },
            {
              n: "02",
              t: "The agent plugs in",
              p: (
                <>
                  One <code>claude mcp add</code>, a Cursor deeplink, or a pasted connector URL. The tool list is the
                  permission surface: a pay-only card never sees <code>execute</code>.
                </>
              ),
            },
            {
              n: "03",
              t: "It pays, we prove it",
              p: (
                <>
                  Each <code>pay</code> is checked against the terms, redeemed gaslessly on Base in USDC from your
                  wallet, then anchored and <span className="hl">proven onto Creditcoin</span> — no oracle, no bridge.
                </>
              ),
            },
          ].map((s) => (
            <motion.div key={s.n} className="step" variants={rise}>
              <span className="sn">{s.n}</span>
              <h3>{s.t}</h3>
              <p>{s.p}</p>
            </motion.div>
          ))}
        </div>
      </Section>

      {/* ---- features as sticky notes ---- */}
      <Section id="features" eyebrow="What a card can do" title={<>Everything a card should be, <span className="hl">rebuilt</span> for agents.</>}>
        <div className="notes">
          <Note k="Scope" tone="mint" title="Terms the chain enforces" foot="ERC-7710 caveats · Base mainnet">
            Period budget, lifetime cap, per-payment max, merchant allowlist, expiry, usage count. The enforcers check
            every one again on-chain, so the server can never approve what the chain would reject.
          </Note>
          <Note k="Kill switch" title="Revoke, and it's dead" foot="server-side instantly · on-chain underneath">
            Freeze or revoke a card — or its whole sub-card tree — and every payment stops. Sub-cards nest tighter terms
            for sub-agents and die with their parent.
          </Note>
          <Note k="Proof" tone="teal" title="Proven on Creditcoin" foot="Attestcoin Block Prover · 0x0FD2">
            Every confirmed payment is anchored on an attested chain and verified by the Attestcoin precompile. The
            facts are decoded from the proven bytes, so no relayer can alter them in flight.
          </Note>
          <Note k="Rails" title="Pays the open web" foot="x402 · Visa (test mode) · contract calls">
            <code>paid_fetch</code> settles HTTP 402 challenges automatically; a fiat lane buys over Visa rails; contract
            cards run scoped swaps and approvals atomically.
          </Note>
          <Note k="Credit" tone="yellow" title="History that unlocks capital" foot="EIP-712 lines · CTC guarantees">
            Lenders open credit lines to an agent's funding account. Draws and repayments are ordinary payments, proven
            into a Creditcoin state machine; bonds in CTC stand behind agents with no history yet.
          </Note>
          <Note k="Operate" title="Built to run, not to demo" foot="webhooks · teams · audit · SDK">
            Signed webhooks with retries, roles over shared cards, a CSV-exportable audit log, budget alerts, and a
            typed SDK. Every hop traced into SigNoz.
          </Note>
        </div>
      </Section>

      {/* ---- credit ---- */}
      <Section id="credit" eyebrow="Credit lines & the passport" title={<>A public record any dApp can <span className="hl">underwrite</span> against.</>}>
        <div className="lpsplit" style={{ marginTop: 40 }}>
          <div>
            <p className="lplede">
              <code>CreditPassport.passportOf(account)</code> composes an agent&apos;s verified payments, credit lines
              drawn, repaid and defaulted, disputes, and the CTC bonded behind it — and scores it on-chain from a
              published formula. Off-chain, the same record ships as a signed credential anyone can verify in one call.
            </p>
            <ul className="docul" style={{ marginTop: 20 }}>
              <li className="docli">Both parties sign line terms under an EIP-712 domain; anyone may register them.</li>
              <li className="docli">A draw pays from the lender&apos;s own card, so the chain enforces the ceiling twice.</li>
              <li className="docli">Defaults are mechanical: a balance past expiry, provable, slashable in the lender&apos;s favour.</li>
              <li className="docli">Disputes and revocations are proven with timestamps — &ldquo;was this card live when it paid me?&rdquo; has a checkable answer.</li>
            </ul>
          </div>
          <motion.div className="mockpass" variants={rise} initial="hidden" whileInView="show" viewport={{ once: true, margin: "-60px" }}>
            <SketchStar className="sk" size={64} />
            <div className="mp-head">
              <div>
                <div className="mp-k">Credit passport</div>
                <div className="mono" style={{ marginTop: 4, fontSize: 12, color: "var(--label)" }}>0x66b6…EC5a</div>
              </div>
              <span className="mp-grade">A</span>
            </div>
            <div className="mp-rows">
              <div className="mp-row"><span>Score</span><b className="mp-score">92 / 100</b></div>
              <div className="mp-row"><span>Verified payments</span><b>47 · 118.20 USDC</b></div>
              <div className="mp-row"><span>Lines repaid / defaulted</span><b>3 / 0</b></div>
              <div className="mp-row"><span>Disputes upheld</span><b>0</b></div>
              <div className="mp-row"><span>Bonded behind</span><b>25.00 CTC</b></div>
            </div>
            <div className="mp-sig">signed · EIP-191 · anchorer 0x66b6082E…C4EC5a · expires in 24h</div>
          </motion.div>
        </div>
      </Section>

      {/* ---- connect ---- */}
      <Section id="connect" eyebrow="Connecting an agent" title={<>One line in any harness.</>}>
        <div className="lpsplit rev" style={{ marginTop: 32 }}>
          <div>
            <pre className="lpcode">{`# Lane A · secret in the URL path
claude mcp add --transport http remit `}<span className="y">https://&lt;host&gt;/c/&lt;card-secret&gt;/mcp</span>{`

# Lane C · OAuth 2.1, card-picker consent
claude mcp add --transport http remit https://<host>/mcp
`}<span className="c"># the client discovers the OAuth lane on the 401, registers itself,
# and opens a browser: you pick which card to grant.</span></pre>
            <div className="lpharness">
              {["Claude Code", "claude.ai", "Cursor", "VS Code", "Codex", "Gemini CLI", "Goose", "Windsurf", "ChatGPT", "OpenClaw", "Amp", "Droid"].map((h) => (
                <span key={h}>{h}</span>
              ))}
            </div>
          </div>
          <div>
            <p className="lplede">
              The card <em>is</em> the connection. Behind the URL sits a scoped delegation; the agent holds the card,
              never the money. Rotate the secret from the dashboard and the old URL dies instantly.
            </p>
            <p className="lplede" style={{ marginTop: 12 }}>
              Refusals are typed — <code>over_period_limit</code>, <code>merchant_not_allowed</code>,{" "}
              <code>price_exceeds_max</code> — so an agent can relay them honestly instead of guessing.
            </p>
          </div>
        </div>

        <div className="lphonest">
          <div>
            <h4>Proven, trustlessly</h4>
            <p>
              That a payment record with exactly these values was included in a block attested by the Attestcoin
              network. The precompile checks the Merkle inclusion and continuity proofs in the same Creditcoin
              transaction that records the result.
            </p>
          </div>
          <div>
            <h4>Not proven — and we say so</h4>
            <p>
              That the underlying Base transfer happened: the anchorer asserts it, and the Base transaction hash is
              recorded so anyone can check. The day Attestcoin attests Base, the server picks it up from the registry
              and this caveat disappears.
            </p>
          </div>
        </div>
      </Section>

      {/* ---- closing band ---- */}
      <div className="lpwrap">
        <motion.div className="lpband" variants={rise} initial="hidden" whileInView="show" viewport={{ once: true, margin: "-60px" }}>
          <SketchArrow className="sk" size={140} />
          <h2 className="lph2">Your agent&apos;s first card takes about a minute.</h2>
          <p className="lplede">Real USDC on Base mainnet. The only simulated leg is the Visa rail, labelled wherever it appears.</p>
          <div className="lpctas">
            <Link className="abtn primary big arrow" href="/app">
              Open the dashboard
            </Link>
            <Link className="abtn big" href="/passport/0x66b6082Eb6c7a9457F25479fa35b6061F2c4EC5a">
              See a live passport
            </Link>
          </div>
        </motion.div>

        <footer className="lpfoot">
          <Logo size="sm" />
          <nav aria-label="Footer">
            <Link href="/docs">Docs</Link>
            <a href="https://github.com/LSUDOKO/AttestPay" target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a href="https://github.com/LSUDOKO/AttestPay/blob/main/CHANGELOG.md" target="_blank" rel="noreferrer">
              Changelog
            </a>
            <a href="https://github.com/LSUDOKO/AttestPay/blob/main/SECURITY.md" target="_blank" rel="noreferrer">
              Security
            </a>
            <a href="https://github.com/LSUDOKO/AttestPay/blob/main/LICENSE" target="_blank" rel="noreferrer">
              License
            </a>
          </nav>
          <span className="fine">Base mainnet · Creditcoin CC3 testnet · built for the SigNoz hackathon</span>
        </footer>
      </div>
    </div>
  );
}

function Section({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: React.ReactNode; children: React.ReactNode }) {
  return (
    <motion.section
      id={id}
      className="lpsec lpwrap"
      variants={stagger}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: "-80px" }}
      style={{ scrollMarginTop: 96 }}
    >
      <motion.div className="lpeyebrow" variants={rise}>
        {eyebrow}
      </motion.div>
      <motion.h2 className="lph2" variants={rise}>
        {title}
      </motion.h2>
      {children}
    </motion.section>
  );
}

function Note({ k, tone, title, foot, children }: { k: string; tone?: "mint" | "teal" | "blush" | "yellow"; title: string; foot: string; children: React.ReactNode }) {
  return (
    <motion.article className={`note${tone ? ` ${tone}` : ""}`} variants={rise}>
      <span className="nk">{k}</span>
      <h3>{title}</h3>
      <p>{children}</p>
      <span className="nfoot">{foot}</span>
    </motion.article>
  );
}
