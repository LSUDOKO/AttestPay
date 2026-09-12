"use client";

// /docs: the reference, in the house style. A quiet left TOC rail (scroll-spy,
// theme toggle + back-to-app at the foot) beside one prose column. Public route,
// no auth: documentation reads the same signed-in or out. Everything here is
// grounded in the actual engine/server/dashboard code, not aspirational.

import Link from "next/link";
import { Fragment, useEffect, useState } from "react";
import { ThemeToggle } from "../components/Theme";
import { IconCheck, IconCopy, copyText } from "../components/ui";

// ---------------------------------------------------------------------------
// Table of contents: grouped into proper sections (drives the nav). The groups
// follow the body's reading order exactly, so the scroll-spy and the clicks
// never jump out of sequence.
// ---------------------------------------------------------------------------

const NAV: { group: string; items: { id: string; label: string }[] }[] = [
  {
    group: "Concepts",
    items: [
      { id: "overview", label: "Overview" },
      { id: "lifecycle", label: "How a Payment Works" },
    ],
  },
  {
    group: "Cards",
    items: [
      { id: "issuing", label: "Issuing a Card" },
      { id: "terms", label: "Card Terms" },
    ],
  },
  {
    group: "Connect",
    items: [
      { id: "connect", label: "Connecting an Agent" },
      { id: "tools", label: "MCP Tools" },
    ],
  },
  {
    group: "Advanced",
    items: [
      { id: "execute", label: "Contract Cards" },
      { id: "subcards", label: "Sub-Cards & Revocation" },
    ],
  },
  {
    group: "Operate",
    items: [
      { id: "rails", label: "Payment Rails" },
      { id: "security", label: "Security" },
    ],
  },
  {
    group: "SigNoz",
    items: [
      { id: "signoz-overview", label: "Observability Overview" },
      { id: "signoz-traces", label: "Traces" },
      { id: "signoz-metrics", label: "Metrics" },
      { id: "signoz-logs", label: "Structured Logs" },
      { id: "signoz-dashboard", label: "Dashboard & Queries" },
      { id: "signoz-mcp", label: "SigNoz MCP" },
      { id: "signoz-alerts", label: "Alerts & Self-Hosting" },
    ],
  },
  {
    group: "Reference",
    items: [
      { id: "api", label: "API Reference" },
      { id: "selfhost", label: "Self-Hosting" },
      { id: "cookoff", label: "The Cook Off" },
    ],
  },
];
const FLAT = NAV.flatMap((g) => g.items);

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function Code({ code }: { code: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="doccode">
      <pre>{code}</pre>
      <button
        className={`doccopy${done ? " done" : ""}`}
        aria-label="Copy to clipboard"
        title="Copy"
        onClick={async () => {
          if (await copyText(code)) {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          }
        }}
      >
        {done ? <IconCheck /> : <IconCopy />}
      </button>
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="doctablewrap">
      <table className="doctable">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Note({ children, warn }: { children: React.ReactNode; warn?: boolean }) {
  return (
    <div className={`docnote${warn ? " warn" : ""}`}>
      <span className="ni" aria-hidden>
        {warn ? (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 1.6 15 13.5H1z" />
            <path d="M8 6.2v3.6M8 11.6v.1" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="8" cy="8" r="6.6" />
            <path d="M8 7.4v4M8 4.7v.1" />
          </svg>
        )}
      </span>
      <p>{children}</p>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section className="docsec" id={id}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function DocsPage() {
  const [active, setActive] = useState(FLAT[0].id);

  // scroll-spy: highlight the section whose top sits in the upper band of the viewport
  useEffect(() => {
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-12% 0px -72% 0px", threshold: 0 },
    );
    for (const s of FLAT) {
      const el = document.getElementById(s.id);
      if (el) obs.observe(el);
    }
    return () => obs.disconnect();
  }, []);

  return (
    <div className="docs">
      {/* the aurora: subtle page weather behind the chrome */}
      <div className="docaurora" aria-hidden>
        <i className="docbeamA" />
        <i className="docbeamB" />
        <i className="docbeamC" />
      </div>
      <aside className="docnav">              <Link className="brand" href="/">AttestPay</Link>
              <span className="docnavlabel">Documentation</span>
        <nav className="docnavlist">
          {NAV.map((g) => (
            <Fragment key={g.group}>
              <div className="docnavgroup">{g.group}</div>
              {g.items.map((s) => (
                <a key={s.id} className={`docnavitem${active === s.id ? " on" : ""}`} href={`#${s.id}`}>
                  {s.label}
                </a>
              ))}
            </Fragment>
          ))}
        </nav>
        <div className="docnavfoot">
          <ThemeToggle />
          <Link className="docback" href="/">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
            <span>Open the App</span>
          </Link>
        </div>
      </aside>

      <main className="docbody">
        <div className="docwrap">
          {/* hero */}
          <header className="dochero">
            <span className="doceyebrow">The agentic card</span>
            <h1>Documentation</h1>
            <p className="docsub">
              AttestPay issues scoped, revocable spending cards from your wallet. Any agent plugs one in over MCP and
              pays within your limits, holding no keys and no funds, dead the moment you revoke. Here is how it
              works, end to end.
            </p>
          </header>

          {/* ---- Overview ---- */}
          <Section id="overview" title="Overview">
            <p className="docp">
              Agents need to spend money. Handing an agent your private key is reckless; funding a standalone agent
              wallet loses both your custody and your limits. AttestPay takes the model the card industry settled on
              decades ago and applies it to agents: the wallet stays the account, and the agent gets a <b>card</b>,
              a scoped authority to draw from it.
            </p>
            <ul className="docul">
              <li className="docli">
                <b>Your wallet is the account.</b> Funds never leave it until the moment of payment.
              </li>
              <li className="docli">
                <b>The card is a delegation.</b> A scoped ERC-7710 delegation, signed by your wallet, wrapped in
                caveats: budget per period, per-transaction cap, merchant allowlist, expiry, usage count, contract
                scope.
              </li>
              <li className="docli">
                <b>The agent holds the card, not the money.</b> What the agent gets is an MCP endpoint URL. Behind
                it, the card can spend only what its terms allow, signed by an agent key that holds nothing.
              </li>
              <li className="docli">
                <b>Revoke kills it instantly.</b> Freeze or revoke a card (or its whole sub-card tree) and every
                payment stops, server-side immediately and on-chain underneath.
              </li>
            </ul>

            <div className="docdiagram">
              {`your wallet  `}<span className="mut">(EIP-7702 smart account)</span>{`
   └── `}<b>card</b>{`   `}<span className="mut">$25 / week · expires Jul 6</span>{`        ← root delegation, signed by you
        ├── agent A plugs it in over MCP
        └── `}<b>sub-card</b>{`   `}<span className="mut">$1 / week · one merchant</span>{`   ← redelegation, narrower terms
             └── sub-agent B plugs it in`}
            </div>

            <p className="docp">
              AttestPay runs on <b>Base mainnet</b> with real USDC. The only simulated leg is the Visa rail (Stripe
              test-mode Issuing), labeled honestly wherever it appears.
            </p>

            <div className="docfacts">
              <div className="docfact">
                <div className="fk">Dashboard</div>
                <div className="fv">
                  <span>attestpay (your deployment)</span>
                </div>
              </div>
              <div className="docfact">
                <div className="fk">API + MCP</div>
                <div className="fv">
                  <span>attestpay-api (your deployment)</span>
                </div>
              </div>
              <div className="docfact">
                <div className="fk">Demo merchant</div>
                <div className="fv">
                  <a href="https://shop.s0nderlabs.xyz" target="_blank" rel="noreferrer">
                    shop.s0nderlabs.xyz
                  </a>
                </div>
              </div>
            </div>
          </Section>

          {/* ---- Lifecycle ---- */}
          <Section id="lifecycle" title="How a Payment Works">
            <ul className="docul">
              <li className="docli">
                You sign in to the dashboard (Privy embedded wallet, Google or email) and issue a card with terms,
                set by hand in the composer or drafted from plain language by the Venice-powered compiler.
              </li>
              <li className="docli">
                The dashboard compiles those terms into on-chain caveats, your wallet signs the delegation in the
                browser, and the server stores it alongside a fresh agent key that holds nothing.
              </li>
              <li className="docli">
                You hand the card URL to any agent (one <code>claude mcp add</code>, a Cursor deeplink, a pasted
                connector URL).
              </li>
              <li className="docli">
                When the agent calls <code>pay</code>, the server validates the terms, then redeems the delegation
                through the 1Shot Public Relayer: gasless, on Base mainnet, settled in USDC from your wallet.
              </li>
              <li className="docli">
                Every charge lands in the card&apos;s ledger with memo, fee, and tx hash, attributed to the agent
                key that spent it.
              </li>
            </ul>
            <Note>
              The agent never sees a private key, never holds a balance, never needs ETH. The first spend even
              deploys your wallet&apos;s EIP-7702 smart-account code automatically, attached to the same redemption
              as an authorization list.
            </Note>
          </Section>

          {/* ---- Issuing ---- */}
          <Section id="issuing" title="Issuing a Card">
            <p className="docp">
              A card is born from a <code>CardTerms</code> object: a <code>pay</code> budget, a <code>contract</code>{" "}
              scope, or both, plus lifecycle limits (expiry, max uses, per-charge cap, merchant lock, sub-cards
              on/off). You can write the terms by hand in the composer, or describe the card in plain language and let
              the compiler draft them.
            </p>
            <h3>The plain-language compiler</h3>
            <p className="docp">
              The dashboard&apos;s issue modal sends your sentence to Venice AI, which returns a plan of named
              entities (&quot;USDC&quot;, &quot;Uniswap&quot;, &quot;aave&quot;) and numbers. The server then
              resolves every name against its own verified registry (or Basescan, or your own pasted address), so the
              model output can never place a raw address into a draft. The result is a <code>CardTerms</code> draft
              you review and sign; nothing is issued until you do.
            </p>
            <Note>
              The compiler only <b>names</b> tokens, protocols and merchants. Addresses come exclusively from the
              trusted resolvers or your own text, with provenance shown on each chip (registry, Basescan, or your
              input). A draft cannot smuggle a poisoned address even if the model tries.
            </Note>
            <h3>The client-signed ceremony</h3>
            <p className="docp">
              Issuance is a three-step prepare / sign / finalize so the server never holds your key:
            </p>
            <ul className="docul">
              <li className="docli">
                <b>prepare</b>: the server compiles the caveats, mints the agent key, and returns the exact unsigned
                delegation struct.
              </li>
              <li className="docli">
                <b>sign</b>: your embedded wallet signs the EIP-712 delegation in the browser.
              </li>
              <li className="docli">
                <b>finalize</b>: the server verifies the signature recovers to your wallet, then persists the card
                and returns its URL.
              </li>
            </ul>
          </Section>

          {/* ---- Terms ---- */}
          <Section id="terms" title="Card Terms">
            <p className="docp">
              Each term compiles to a delegation-framework enforcer caveat at the root of the delegation, so the
              chain enforces the same limits the server checks. Below is the exact mapping
              (<code>engine/src/compiler.ts</code>).
            </p>
            <Table
              head={["Term", "Meaning", "On-chain enforcer"]}
              rows={[
                [
                  <code key="a">pay.period</code>,
                  "Budget per rolling window (amount + seconds, min 60s)",
                  <code key="b">ERC20PeriodTransfer</code>,
                ],
                [<code key="a">pay.lifetime</code>, "Total USDC the card may ever move", <code key="b">ERC20TransferAmount</code>],
                [<code key="a">contract.targets</code>, "Contracts the card may call", <code key="b">AllowedTargets</code>],
                [<code key="a">contract.selectors</code>, "Method signatures the card may call", <code key="b">AllowedMethods</code>],
                [<code key="a">expiry</code>, "Unix time after which nothing redeems", <code key="b">Timestamp</code>],
                [
                  <code key="a">maxUses</code>,
                  "Redemption count (scaled to executions on-chain; server is the binding limit)",
                  <code key="b">LimitedCalls</code>,
                ],
                [
                  "revocation nonce",
                  "Always present; bumping it nukes every card from this wallet",
                  <code key="b">Nonce</code>,
                ],
                [
                  "pay + contract",
                  "A composite card; one group governs each redemption",
                  <code key="b">LogicalOrWrapper</code>,
                ],
              ]}
            />
            <Note>
              <b>perTxMax</b> and <b>merchants</b> are not root caveats; they collide with the mandatory fee leg
              there. They are server-side carve policy applied at redemption: the per-transaction max is backstopped
              on-chain by the carved leaf&apos;s amount scope, while the merchant allowlist is enforced server-side.{" "}
              <b>contract.tokens</b> and <b>contract.perTradeMax</b> additionally pin each ERC-20 allowance to an exact
              spender and amount via byte-window <code>AllowedCalldata</code> caveats on that leaf.
            </Note>
          </Section>

          {/* ---- Connect ---- */}
          <Section id="connect" title="Connecting an Agent">
            <p className="docp">
              The card is served over MCP (Streamable HTTP). There are three connection lanes. The first two carry a
              per-card credential directly; the third is OAuth, where the agent never holds the card secret.
            </p>
            <div className="doclanes">
              <div className="doclane">
                <div className="doclanehd">
                  <span className="lanek">A</span>
                  <span className="lt">Secret in the URL path</span>
                </div>
                <p>
                  Works everywhere, including credential-free clients like claude.ai web. The URL is the password,
                  treat it like one.
                </p>
                <Code code={`claude mcp add --transport http attestpay \\
  https://<host>/c/<card-secret>/mcp`} />
              </div>
              <div className="doclane">
                <div className="doclanehd">
                  <span className="lanek">B</span>
                  <span className="lt">Bearer header</span>
                </div>
                <p>For clients that send an Authorization header. The bare endpoint, secret in the header.</p>
                <Code code={`claude mcp add --transport http attestpay \\
  https://<host>/mcp \\
  --header "Authorization: Bearer <card-secret>"`} />
              </div>
              <div className="doclane">
                <div className="doclanehd">
                  <span className="lanek">C</span>
                  <span className="lt">OAuth 2.1 (card-picker consent)</span>
                </div>
                <p>
                  Add the bare endpoint with no credential. The client discovers the OAuth lane (RFC 9728 metadata on
                  the 401), registers itself (dynamic client registration), and opens a browser; you sign in and pick
                  which card to grant. The agent receives a short-lived, card-scoped, independently revocable token,
                  never the raw secret. This is the lane OAuth-only clients such as ChatGPT require. Clients that
                  finish OAuth out of band read the code off the consent screen: OpenClaw completes with{" "}
                  <code>openclaw mcp login attestpay --code &lt;code&gt;</code>, and headless Hermes uses the same
                  paste-back.
                </p>
                <Code code={`claude mcp add --transport http attestpay https://<host>/mcp`} />
              </div>
            </div>

            <h3>Per-harness one-liners (Lane A)</h3>
            <Code code={`codex     mcp add attestpay --url https://<host>/c/<secret>/mcp
openclaw  mcp add attestpay --url https://<host>/c/<secret>/mcp --transport streamable-http  # flag required: omitting it defaults to SSE
hermes    mcp add attestpay --url "https://<host>/c/<secret>/mcp"
gemini    mcp add -t http attestpay https://<host>/c/<secret>/mcp
goose     session --with-streamable-http-extension "https://<host>/c/<secret>/mcp"
amp       mcp add attestpay https://<host>/c/<secret>/mcp
droid     mcp add attestpay https://<host>/c/<secret>/mcp --type http`} />
            <p className="docp">
              Lanes A and B work in Cursor, VS Code, Gemini CLI, Windsurf, claude.ai custom connectors, or any MCP
              client that speaks Streamable HTTP. For claude.ai web, paste the card URL under Customize → Connectors →
              Add custom connector; for ChatGPT Developer Mode, add it as a No Authentication connector (or use Lane C
              for a real auth story). The dashboard&apos;s connect panel renders a prefilled install affordance per
              harness. Rotate the secret any time from the dashboard; the old URL dies instantly.
            </p>
          </Section>

          {/* ---- Tools ---- */}
          <Section id="tools" title="MCP Tools">
            <p className="docp">
              The tool list a card exposes <b>is</b> its permission surface: a pay-only card never sees{" "}
              <code>execute</code>; a contract-only card never sees <code>pay</code>; a sub-cards-off card never sees{" "}
              <code>issue_subcard</code>. The server is stateless, a fresh instance per request, identity = the card
              credential.
            </p>
            <Table
              head={["Tool", "On", "Purpose"]}
              rows={[
                [<code key="t">card</code>, "Every card", "Live state: remaining budget, terms, expiry, recent charges, sub-cards, and the card's on-chain account (the root delegator that holds the USDC and receives contract-call output). Call it first."],
                [<code key="t">pay</code>, "pay cards", "Send USDC on Base within limits; blocks until confirmed on-chain."],
                [<code key="t">paid_fetch</code>, "pay cards", "Fetch a URL; on HTTP 402 (x402), pay automatically and return the content."],
                [<code key="t">fiat_pay</code>, "pay + Stripe", "Buy over Visa rails (simulated) against the same budget; with settlement on, the receipt carries the on-chain tx."],
                [<code key="t">card_credentials</code>, "pay + Stripe", "Reveal the test-mode virtual Visa for a merchant checkout; every card auto-links one on first need."],
                [<code key="t">execute</code>, "contract cards", "Run scoped contract calls (approve + swap, stake, mint) atomically in one redemption."],
                [<code key="t">issue_subcard</code>, "sub-cards on", "Mint a tighter child card for a sub-agent; omitted money terms inherit the parent's remaining budget; returns its URL."],
                [<code key="t">revoke_subcard</code>, "sub-cards on", "Instantly kill a sub-card and its descendants (server-side)."],
              ]}
            />
            <h3>Typed refusals</h3>
            <p className="docp">
              Refusals come back as <code>isError</code> with structured JSON naming the violated term, so an agent
              can relay them honestly instead of guessing. The codes include:
            </p>
            <ul className="docul">
              <li className="docli">
                <code>over_period_limit</code>, <code>merchant_not_allowed</code>, <code>price_exceeds_max</code> (pay
                and paid_fetch)
              </li>
              <li className="docli">
                <code>target_not_allowed</code>, <code>method_not_allowed</code>, <code>per_trade_exceeded</code>,{" "}
                <code>token_not_allowed</code>, <code>spender_not_allowed</code> (execute)
              </li>
              <li className="docli">
                <code>exceeds_parent_terms</code> (issue_subcard); <code>not_your_subcard</code> (revoke_subcard)
              </li>
              <li className="docli">
                <code>card_frozen</code>, <code>no_fiat_card</code> (the fiat leg); <code>invalid_terms</code> (bad
                input)
              </li>
            </ul>
          </Section>

          {/* ---- Execute / contract cards ---- */}
          <Section id="execute" title="Contract Cards">
            <p className="docp">
              A card can be scoped to specific contract targets and method selectors instead of (or alongside) a USDC
              budget. The agent calls <code>execute</code> with either <code>{`{target, method, args}`}</code> (the
              server ABI-encodes the calldata) or <code>{`{target, data}`}</code> raw calldata for tuple/array/
              multicall methods like Uniswap <code>exactInputSingle</code>.
            </p>
            <ul className="docul">
              <li className="docli">
                Targets and selectors outside the card&apos;s declared scope are refused before anything reaches the
                chain; the on-chain <code>AllowedTargets</code> / <code>AllowedMethods</code> enforcers check the same
                scope again at redemption.
              </li>
              <li className="docli">
                Method signatures are normalized to canonical form (<code>uint</code> → <code>uint256</code>) so the
                encoder, the raw-data selector check, and the on-chain enforcer all agree.
              </li>
              <li className="docli">
                A contract card can carry an <b>allowance token list</b> (<code>contract.tokens</code>: the only
                tokens it may <code>approve</code>, each approval pinned on-chain to an exact spender and amount; the
                listed tokens are auto-unioned into the card&apos;s targets) and a <b>per-trade ceiling</b>{" "}
                (<code>contract.perTradeMax</code>, capping each USDC approval; v1 enforces the ceiling on the USDC /
                settlement leg only, while non-USDC approvals stay exact-amount pinned).
              </li>
              <li className="docli">
                For a call that needs a recipient (e.g. <code>exactInputSingle</code>&apos;s <code>recipient</code>),
                the <code>card</code> tool surfaces the card&apos;s on-chain <code>account</code> (the root delegator
                that holds the USDC and receives any output tokens), so the agent routes a swap&apos;s output there
                itself rather than guessing or asking the user.
              </li>
              <li className="docli">
                Contract calls carry no native ETH value in v1 (the carved leaf caps value at 0 on-chain); up to 5
                calls batch atomically into one redemption.
              </li>
            </ul>
            <Note>
              Contract calls are not USDC-metered. Safety on a contract card is the target/method allowlist plus{" "}
              <code>maxUses</code> and <code>expiry</code>. Pair contract scope with a <code>pay</code> cap in one
              composite card when you want both rails under one delegation.
            </Note>
          </Section>

          {/* ---- Sub-cards & revocation ---- */}
          <Section id="subcards" title="Sub-Cards & Revocation">
            <p className="docp">
              Sub-cards are ERC-7710 redelegations. An agent holding a card can mint a tighter child for a sub-agent
              with <code>issue_subcard</code>; every term must fit inside the parent&apos;s (caps only narrow
              downward, contract scope is subset-only, never silently inherited). <code>exceeds_parent_terms</code>{" "}
              names the violating field. The chain enforces the same subset via the delegation chain.
            </p>
            <h3>Three layers of off-switch</h3>
            <Table
              head={["Layer", "Effect", "Where"]}
              rows={[
                ["Freeze", "Reversible pause; the card still answers card but refuses spends", "Server-side, instant"],
                ["Revoke", "Permanent; the card and its whole sub-card subtree die", "On-chain disableDelegation, signed by your wallet"],
                ["Nuke", "Kills every card and sub-card this wallet ever issued", "One on-chain NonceEnforcer bump"],
              ]}
            />
            <p className="docp">
              All three are user-operable from the dashboard. On-chain revoke and nuke are signed by your own embedded
              wallet in the browser (an admin leaf delegation) and ride the relayer gaslessly. Revoking a parent kills
              the subtree; the cascade is the demo money-shot, revoke the root and the whole tree dies on screen.
            </p>
            <Note>
              An agent&apos;s own <code>revoke_subcard</code> is a server-side kill: instant, and the sub-card&apos;s
              URL dies, but a sub-card cannot be disabled on-chain on its own (its on-chain delegator is the
              parent&apos;s agent key). On-chain permanence for a whole branch comes from revoking the root card or
              nuking.
            </Note>
          </Section>

          {/* ---- Rails ---- */}
          <Section id="rails" title="Payment Rails">
            <p className="docp">Two payment rails run off one delegation, metered by the same enforcers.</p>
            <h3>x402 (real, live)</h3>
            <p className="docp">
              <code>paid_fetch</code> answers an HTTP 402 challenge by paying through the card&apos;s 7710 delegation:
              real x402 v2 flows on Base mainnet, USDC settled from your wallet through the 1Shot Public Relayer
              (gasless, fee in USDC). AttestPay also ships the first ERC-7710 x402 facilitator
              (<code>/facilitator/verify</code>, <code>/settle</code>, <code>/supported</code> advertising{" "}
              <code>assetTransferMethod: erc7710</code>) and a demo seller at <code>/demo/premium-data</code> whose 402
              points back at it.
            </p>
            <h3>Stripe Issuing Visa (simulated)</h3>
            <p className="docp">
              <code>fiat_pay</code> and <code>card_credentials</code> drive a test-mode virtual Visa. When a charge is
              authorized, Stripe calls AttestPay&apos;s real-time auth webhook, which answers approve/decline from the
              card&apos;s on-chain delegation state inside Stripe&apos;s hard 2-second window (read from a cached
              snapshot, never an RPC call in the handler). A decline comes back typed, from the card&apos;s terms, not
              the merchant.
            </p>
            <p className="docp">
              With settlement enabled, an approved Visa charge then settles as a <b>real delegated USDC transfer</b>{" "}
              on Base, through the same enforcers that meter the crypto rail. One budget, two rails. A charge whose
              settlement cannot land parks <code>settlement_unconfirmed</code> and freezes the card rather than ever
              releasing its budget.
            </p>
            <Note warn>
              The Visa leg is <b>simulated by design</b>: Stripe test-mode Issuing, no real merchant, no KYC required
              in test. It is labeled honestly everywhere it appears. The crypto rail and the on-chain settlement move
              real USDC on Base mainnet.
            </Note>
            <p className="docp">
              The demo merchant, <b>s0nder supply co.</b> at <code>/shop</code>, is a real storefront that accepts the
              cards&apos; Visas. The catalog is priced at $5 or less because approved purchases move real USDC.
            </p>
          </Section>

          {/* ---- Security ---- */}
          <Section id="security" title="Security">
            <ul className="docul">
              <li className="docli">
                <b>Custody.</b> Your funds stay in your wallet. The per-card agent key signs redelegations only; it
                holds no assets and is encrypted at rest. You can export your wallet&apos;s private key from the
                account menu at any time (through Privy&apos;s secure modal, rendered in a separate-domainiframe AttestPay never reads) and walk away to any client.
              </li>
              <li className="docli">
                <b>Dashboard auth.</b> Per-user Privy sessions, verified server-side against the app JWKS. At onboard,
                the embedded wallet signs <code>attestpay-onboard:v1:&lt;did&gt;</code> to bind the wallet to that login;
                every card route is then scoped to the authenticated user&apos;s own cards.
              </li>
              <li className="docli">
                <b>Issuance integrity.</b> The server verifies the delegation signature recovers to the delegator
                before persisting a card.
              </li>
              <li className="docli">
                <b>Card secrets.</b> 256-bit, stored as a hash for auth and AES-256-GCM-encrypted at rest for the
                reveal/rotate feature. The URL is a credential; rotate it like a password.
              </li>
              <li className="docli">
                <b>Limits enforced twice.</b> Server-side at call time (typed refusals) and on-chain at redemption.
                Period, lifetime, expiry, usage count and contract target/method have dedicated on-chain enforcers; the
                per-transaction max and merchant allowlist are server-side policy, backstopped on-chain by the carved
                leaf&apos;s amount scope.
              </li>
              <li className="docli">
                <b>MCP surface hardening.</b> Host allowlist (DNS-rebinding guard), per-card and bad-secret rate
                limits, a 1 MiB body cap, an SSRF guard on <code>paid_fetch</code> targets, secrets never echoed in
                errors or logs.
              </li>
              <li className="docli">
                <b>OAuth tokens.</b> Opaque, card-scoped, hash-stored beside the card secrets, audience-pinned (RFC
                8707), and revoked the instant the card is, cascading to the subtree.
              </li>
            </ul>
          </Section>

          {/* ---- SigNoz Observability ---- */}
          <Section id="signoz-overview" title="SigNoz Observability">
            <p className="docp">
              AttestPay is <b>fully instrumented with OpenTelemetry</b> and ships <b>traces, metrics, and logs</b> to{" "}
              <b>SigNoz Cloud</b> (and can self-host locally via the included <code>casting.yaml</code>). Every card
              issuance, every payment, every refusal, every API call — all visible in SigNoz.
            </p>

            <h3>Architecture</h3>
            <div className="docdiagram">
              {`attestpay-server (Bun ─preload otel.ts)
   │
   ├─ @opentelemetry/auto-instrumentations-node
   │  · HTTP spans (every API call)
   │  · fetch spans (outbound requests)
   │  · DNS, filesystem, database
   │
   ├─ Manual business spans (trace API)
   │  · stripe_webhook_auth   (approve/decline decision)
   │  · 1shot_relayer_redeem  (on-chain payment)
   │  · nl_compile            (AI card compilation)
   │  · reconcile_sweep       (stuck charge resolution)
   │  · fiat_settle_sweep     (Visa→USDC settlement)
   │
   ├─ Custom metrics (Meter API)
   │  · counters: cards_issued, charges, errors, usdc_spent
   │  · gauge: active_cards
   │
   ├─ Structured logs (Logger API)
   │  · card_event: issued, frozen, revoked, nuked, onboarded
   │  · charge_event: confirmed, refused, pending
   │  · operation: every API error with route, method, status
   │
   └─ OTLP HTTP exporter  →  SigNoz Cloud (or local :4318)`}
            </div>

            <h3>Env vars (already set on Railway)</h3>
            <Code code={`OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.us2.signoz.cloud
OTEL_EXPORTER_OTLP_HEADERS=signoz-ingestion-key=YOUR_KEY
OTEL_TRACES_EXPORTER=otlp
OTEL_METRICS_EXPORTER=otlp
OTEL_LOGS_EXPORTER=otlp`} />
            <p className="docp">
              The OTel SDK initializes early via Bun <code>--preload</code> (<code>packages/server/src/otel.ts</code>)
              so auto-instrumentation wraps every module from boot. The engine package (<code>packages/engine/src/telemetry.ts</code>)
              declares all custom metrics and structured log functions — 5 counters, 2 log emitters, available for any
              SigNoz dashboard panel.
            </p>
          </Section>

          <Section id="signoz-traces" title="Traces — Distributed Tracing">
            <p className="docp">
              Every API request is wrapped in a root span by Hono middleware (<code>app.ts</code>) with attributes for
              route pattern, HTTP method, URL, and response status code. Inside those (and running on their own
              intervals), six custom business-logic spans carry domain-specific attributes.
            </p>

            <h3>Route-level spans (every request)</h3>
            <p className="docp">
              The Hono <code>app.use(&quot;*&quot;, ...)</code> middleware creates a span for every request, named{" "}
              <code>{'HTTP {METHOD} {ROUTE}'}</code>. Navigate to <b>SigNoz → Traces</b>, filter by{" "}
              <code>service.name = attestpay-server</code>, and see every API call with its duration, status, and route
              pattern.
            </p>

            <h3>stripe_webhook_auth</h3>
            <p className="docp">
              Fires when Stripe calls the real-time auth webhook. Attributes: <code>decision</code> (approve/decline),{" "}
              <code>card_id</code>, <code>amount</code>, <code>merchant</code>. Traces the full auth decision flow
              inside Stripe&apos;s 2-second window.
            </p>

            <h3>1shot_relayer_redeem</h3>
            <p className="docp">
              Fires on every on-chain payment. Attributes: <code>usdc_amount</code> (string), <code>gas_fee_usdc</code>,{" "}
              <code>memo</code>, <code>tx_hash</code>, <code>card_id</code>. Shows the full lifecycle of a USDC
              redemption through the 1Shot Public Relayer.
            </p>

            <h3>nl_compile</h3>
            <p className="docp">
              Fires when Venice AI compiles a plain-language card request. Attributes: <code>prompt_tokens</code>,{" "}
              <code>completion_tokens</code>, <code>model</code>. Tracks AI usage for cost monitoring.
            </p>

            <h3>reconcile_sweep</h3>
            <p className="docp">
              Runs on a configurable interval (default 5 min). Attributes: <code>reconciled</code> (count),{" "}
              <code>still_pending</code> (count). Resolves stuck pending charges against chain truth.
            </p>

            <h3>fiat_settle_sweep</h3>
            <p className="docp">
              Runs on a configurable interval (default 60s). Attributes: <code>settled</code> (count),{" "}
              <code>left</code> (count). Settles approved Visa charges as on-chain USDC transfers.
            </p>
          </Section>

          <Section id="signoz-metrics" title="Metrics — Product KPIs">
            <p className="docp">
              Five custom counters are available in SigNoz Metrics. Navigate to <b>SigNoz → Metrics</b> and search for
              any of the following metric names to build dashboard panels.
            </p>

            <Table
              head={["Metric Name", "Type", "Description"]}
              rows={[
                [<code key="m">attestpay_cards_issued_total</code>, "Counter", "Total cards issued across all users (root + sub-cards). Increments on issue, finalize, and sub-card mint."],
                [<code key="m">attestpay_usdc_spent_total</code>, "Counter", "Total USDC spent across all confirmed redemptions and fiat settlements. The dollar volume metric."],
                [<code key="m">attestpay_active_cards</code>, "UpDownCounter", "Current live cards (issued − revoked). A gauge: add 1 on issue, subtract 1 on revoke/nuke."],
                [<code key="m">attestpay_charges_total</code>, "Counter", "Total charges processed (confirmed + pending + failed). Payment throughput metric."],
                [<code key="m">attestpay_errors_total</code>, "Counter", "Total API-level errors (403 refusals, 422 validation errors, 502 relay failures, 500 exceptions)."],
              ]}
            />

            <p className="docp">
              These metrics are created in <code>packages/engine/src/telemetry.ts</code> using the OpenTelemetry Metrics
              API and exported via OTLP HTTP to SigNoz. They appear in the Metrics explorer under their metric names,
              prefixed by the engine package.
            </p>

            <h3>Building a metric panel</h3>
            <p className="docp">
              In SigNoz, create a new dashboard, click <b>New Panel</b>, choose <b>Time Series</b>, then switch to the{" "}
              <b>ClickHouse</b> query tab. The SigNoz metrics storage uses the{" "}
              <code>signoz_metrics.distributed_samples_v2</code> table. Example query for cards issued:
            </p>
            <Code code={`SELECT toStartOfInterval(
         toDateTime(intDiv(timestamp_ms, 1000)),
         INTERVAL 5 MINUTE) AS ts,
       sum(value) AS value
FROM signoz_metrics.distributed_samples_v2
WHERE metric_name = 'attestpay_cards_issued_total'
  AND ts BETWEEN $start_datetime AND $end_datetime
GROUP BY ts
ORDER BY ts`} />
          </Section>

          <Section id="signoz-logs" title="Structured Logs — Event-Driven Observability">
            <p className="docp">
              AttestPay emits structured logs for every significant card lifecycle event. Navigate to <b>SigNoz → Logs</b>{" "}
              and filter by <code>card_event</code>, <code>charge_event</code>, <code>refusal_reason</code>, or{" "}
              <code>operation</code> to see exactly what happened.
            </p>

            <h3>Card lifecycle events</h3>
            <Table
              head={["Attribute", "Events", "Context"]}
              rows={[
                [<code key="m">card_event</code>, <code key="v">issued, frozen, unfrozen, revoked, nuked, url_revealed, secret_rotated, onboarded</code>, "Every card lifecycle transition with card_id and extra attributes (k_agent_address, address, has_auth7702 for onboarded)."],
                [<code key="m">charge_event</code>, <code key="v">confirmed</code>, "Successful payments with amount (string), kind (crypto/fiat), and card_id."],
                [<code key="m">refusal_reason</code>, <code key="v">over_period_limit, merchant_not_allowed, price_exceeds_max, card_frozen, …</code>, "Typed refusal with attempted_amount and card_id. Every declined payment leaves a structured trace."],
                [<code key="m">operation</code>, <code key="v">{'HTTP {METHOD} {ROUTE}'}</code>, "API error logs with status code, error_message, and route info. Every 403/422/502/500 is logged."],
              ]}
            />

            <h3>Example log searches</h3>
            <ul className="docul">
              <li className="docli"><code>card_event: &quot;issued&quot;</code> — see every card being created in real-time</li>
              <li className="docli"><code>card_event: &quot;revoked&quot;</code> — track card revocations</li>
              <li className="docli"><code>refusal_reason: *</code> — all payment refusals with typed reasons</li>
              <li className="docli"><code>charge_event: &quot;confirmed&quot;</code> — successful payments with amounts</li>
              <li className="docli"><code>operation: *</code> — all API errors grouped by operation</li>
            </ul>

            <p className="docp">
              Logs are emitted using the OpenTelemetry Logger API (<code>@opentelemetry/api-logs</code>) through the{" "}
              <code>logger.emit()</code> function. Each log carries its <code>severityText</code> (INFO, WARN, ERROR)
              and structured attributes that SigNoz indexes automatically.
            </p>
          </Section>

          <Section id="signoz-dashboard" title="SigNoz Dashboard & ClickHouse Queries">
            <p className="docp">
              Create a AttestPay dashboard in SigNoz with panels for every metric and trace attribute. Below are the
              ClickHouse queries for each panel type.
            </p>

            <h3>Panel 1: Cards Issued Over Time</h3>
            <p className="docp">
              Panel Type: <b>Time Series</b>. Shows the rate of card issuances over time.
            </p>
            <Code code={`SELECT toStartOfInterval(
         toDateTime(intDiv(timestamp_ms, 1000)),
         INTERVAL 5 MINUTE) AS ts,
       sum(value) AS value
FROM signoz_metrics.distributed_samples_v2
WHERE metric_name = 'attestpay_cards_issued_total'
  AND ts BETWEEN $start_datetime AND $end_datetime
GROUP BY ts
ORDER BY ts`} />

            <h3>Panel 2: Active Cards (Gauge)</h3>
            <p className="docp">
              Panel Type: <b>Value</b> (big number). Shows the current live card count.
            </p>
            <Code code={`SELECT sum(value) AS active_cards
FROM signoz_metrics.distributed_samples_v2
WHERE metric_name = 'attestpay_active_cards'
  AND timestamp_ms > toUnixTimestamp(now()) * 1000 - 60000`} />

            <h3>Panel 3: USDC Spent</h3>
            <p className="docp">
              Panel Type: <b>Time Series</b>. Tracks cumulative USDC volume.
            </p>
            <Code code={`SELECT toStartOfInterval(
         toDateTime(intDiv(timestamp_ms, 1000)),
         INTERVAL 5 MINUTE) AS ts,
       sum(value) AS value
FROM signoz_metrics.distributed_samples_v2
WHERE metric_name = 'attestpay_usdc_spent_total'
  AND ts BETWEEN $start_datetime AND $end_datetime
GROUP BY ts
ORDER BY ts`} />

            <h3>Panel 4: API Error Rate</h3>
            <p className="docp">
              Panel Type: <b>Time Series</b>. Track error spikes.
            </p>
            <Code code={`SELECT toStartOfInterval(
         toDateTime(intDiv(timestamp_ms, 1000)),
         INTERVAL 5 MINUTE) AS ts,
       sum(value) AS errors
FROM signoz_metrics.distributed_samples_v2
WHERE metric_name = 'attestpay_errors_total'
  AND ts BETWEEN $start_datetime AND $end_datetime
GROUP BY ts
ORDER BY ts`} />

            <h3>Panel 5: API Request Duration by Route</h3>
            <p className="docp">
              Panel Type: <b>Time Series</b>. Uses trace data to show P99 latency per API route.
            </p>
            <Code code={`SELECT toStartOfInterval(timestamp, INTERVAL 5 MINUTE) AS ts,
       attributes_string['http.route'] AS route,
       avg(durationNano) / 1000000 AS avg_ms
FROM signoz_traces.distributed_signoz_index_v2
WHERE resources_string['service.name'] = 'attestpay-server'
  AND ts BETWEEN $start_datetime AND $end_datetime
GROUP BY ts, route
ORDER BY ts`} />

            <Note>
              The <code>bodyAttributes</code> access pattern varies by SigNoz version. In newer versions, use{" "}
              <code>bodyAttributes[&apos;http.route&apos;]</code>. The <code>$start_datetime</code> and{" "}
              <code>$end_datetime</code> variables are automatically provided by the SigNoz dashboard panel builder.
            </Note>
          </Section>

          <Section id="signoz-mcp" title="SigNoz MCP — AI-Agent Observability">
            <p className="docp">
              The included <code>casting.yaml</code> ships a <b>SigNoz MCP server</b> alongside the SigNoz stack. This
              lets your AI agent query traces, logs, and metrics directly — and even create dashboards and alerts
              autonomously.
            </p>

            <h3>Connect your agent to SigNoz MCP</h3>
            <Code code={`# Self-hosted (from casting.yaml):
claude mcp add signoz http://localhost:8000 \\
  --header "Authorization: Bearer attestpay_mcp_dev"

# SigNoz Cloud (API-based):
claude mcp add signoz https://signoz.io/api/mcp \\
  --header "Authorization: Bearer $YOUR_SIGNOZ_API_KEY"`} />

            <h3>Available MCP tools</h3>
            <p className="docp">
              Once connected, your agent can use SigNoz MCP tools for observability workflows:
            </p>
            <ul className="docul">
              <li className="docli">
                <b>signoz_search_docs</b> — Search SigNoz documentation for guides and references.
              </li>
              <li className="docli">
                <b>signoz_create_dashboard</b> — Create new dashboards with panels for AttestPay metrics.
              </li>
              <li className="docli">
                <b>signoz_modify_dashboard</b> — Update existing dashboard panels and configurations.
              </li>
              <li className="docli">
                <b>signoz_create_alert</b> — Set up alerts for error rate spikes, card issuance stalls, etc.
              </li>
              <li className="docli">
                <b>signoz_investigate_alert</b> — Deep-dive into alert-triggered incidents with neighbor signals.
              </li>
              <li className="docli">
                <b>signoz_generate_query</b> — Generate ClickHouse queries for AttestPay observability data.
              </li>
              <li className="docli">
                <b>signoz_explain_dashboard</b> — Understand existing dashboard layouts and panel semantics.
              </li>
              <li className="docli">
                <b>signoz_manage_views</b> — Create and manage saved views for quick data exploration.
              </li>
            </ul>

            <p className="docp">
              Example: ask your agent <i>&quot;Create a SigNoz dashboard for AttestPay showing cards issued, USDC spent,
              and API error rate&quot;</i> — it will use the MCP tools to build the entire dashboard without you
              touching the SigNoz UI.
            </p>
          </Section>

          <Section id="signoz-alerts" title="Alerts & Self-Hosting">
            <h3>Recommended alerts</h3>
            <p className="docp">
              Set up these alerts in SigNoz to monitor AttestPay health:
            </p>
            <Table
              head={["Alert", "Condition", "Severity"]}
              rows={[
                ["High Error Rate", <><code key="a">attestpay_errors_total</code> rate &gt; 10/min for 5 min</>, "Critical"],
                ["No Cards Issued", <><code key="a">attestpay_cards_issued_total</code> has no new value for 30 min</>, "Warning"],
                ["High API Latency", <>P99 HTTP duration &gt; 5000ms for 5 min</>, "Warning"],
                ["Refusal Spike", <>Log count with <code>refusal_reason:*</code> &gt; 20/min</>, "Warning"],
                ["Charge Failure", <><code>charge_event:confirmed</code> rate drops by 50% vs previous hour</>, "Critical"],
              ]}
            />

            <h3>Self-hosted SigNoz (local development)</h3>
            <p className="docp">
              The repo includes a <code>casting.yaml</code> for deploying SigNoz locally using Foundry. This is perfect
              for development and testing without sending telemetry to the cloud.
            </p>
            <Code code={`# Deploy the full SigNoz stack:
foundryctl cast -f casting.yaml --locked

# SigNoz UI:    http://localhost:3301
# OTLP HTTP:    http://localhost:4318
# SigNoz MCP:   http://localhost:8000

# Then set the server env:
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_TRACES_EXPORTER=otlp
OTEL_METRICS_EXPORTER=otlp
OTEL_LOGS_EXPORTER=otlp`} />
            <p className="docp">
              The <code>casting.yaml.lock</code> pins every Docker image to its content digest, ensuring{" "}
              <b>reproducible deployments</b>. Judges can run <code>foundryctl cast -f casting.yaml --locked</code> to
              reproduce the exact SigNoz environment used during development.
            </p>

            <h3>Stack components</h3>
            <Table
              head={["Service", "Image", "Purpose"]}
              rows={[
                ["ClickHouse", <code key="c">clickhouse/clickhouse-server:24.12</code>, "Time-series database storing all traces, metrics, and logs"],
                ["OTel Collector", <code key="c">signoz/signoz-otel-collector:0.119.3</code>, "Receives OTLP from AttestPay and writes to ClickHouse"],
                ["Query Service", <code key="c">signoz/query-service:0.81.0</code>, "SigNoz backend: API for dashboards, alerts, and queries"],
                ["Frontend", <code key="c">signoz/frontend:0.81.0</code>, "SigNoz Web UI at port 3301"],
                ["MCP Server", <code key="c">signoz/mcp-server:latest</code>, "AI-agent observability: expose SigNoz tools to your agent"],
              ]}
            />

            <Note>
              The self-hosted stack requires <b>4 GB RAM</b>, <b>2 CPU cores</b>, and <b>20 GB disk</b> for ClickHouse
              data. For production, use SigNoz Cloud at{" "}
              <a href="https://signoz.io" target="_blank" rel="noreferrer">signoz.io</a> — the same OTLP exporter
              configuration works with just a different endpoint and ingestion key.
            </Note>
          </Section>

          {/* ---- API reference ---- */}
          <Section id="api" title="API Reference">
            <p className="docp">
              The server is one Hono process. The dashboard API lives under <code>/api</code>; the MCP endpoint,
              OAuth lane, x402 facilitator and demo surfaces sit at the root.
            </p>
            <h3>Auth lanes (every /api route)</h3>
            <ul className="docul">
              <li className="docli">
                <b>Admin</b> (<code>Authorization: Bearer &lt;ATTESTPAY_ADMIN_TOKEN&gt;</code>): full access, server-side
                scripts only, never shipped to a browser.
              </li>
              <li className="docli">
                <b>Privy</b> (<code>Authorization: Bearer &lt;Privy access token&gt;</code>): verified offline against
                the app JWKS; every route scoped to the authenticated user.
              </li>
            </ul>
            <h3>Dashboard API (/api)</h3>
            <Table
              head={["Method · Path", "Purpose"]}
              rows={[
                [<code key="p">POST /onboard</code>, "Register the embedded wallet + its 7702 auth + onboard proof"],
                [<code key="p">POST /cards/prepare</code>, "Compile caveats, mint the agent key, return the unsigned delegation"],
                [<code key="p">POST /cards/finalize</code>, "Attach the browser signature, persist the card, return its URL"],
                [<code key="p">POST /cards/compile</code>, "Venice NL → draft CardTerms (never issues)"],
                [<code key="p">GET /cards</code>, "List the user's cards"],
                [<code key="p">GET /cards/:id</code>, "Card detail + charge ledger"],
                [<code key="p">GET /tree</code>, "The card → sub-card tree"],
                [<code key="p">GET /cards/:id/url</code>, "Reveal the card URL"],
                [<code key="p">POST /cards/:id/rotate</code>, "Rotate the card secret (old URL dies)"],
                [<code key="p">GET /cards/:id/fiat</code>, "The linked test-mode Visa (owner view)"],
                [<code key="p">POST /cards/:id/freeze · /unfreeze</code>, "Reversible server-side pause / resume"],
                [<code key="p">POST /cards/:id/revoke/prepare · /finalize</code>, "Client-signed on-chain revoke (sub-cards die server-side)"],
                [<code key="p">POST /nuke/prepare · /finalize</code>, "Client-signed cascade nuke of every card"],
                [<code key="p">DELETE /cards/:id</code>, "Bookkeeping removal of a dead card + its subtree"],
                [<code key="p">GET /oauth/request · POST /oauth/approve · /deny</code>, "The card-picker consent backend"],
              ]}
            />
            <h3>OAuth 2.1 (self-hosted authorization server)</h3>
            <p className="docp">
              Public clients, PKCE S256, auth-code + rotating refresh, dynamic client registration. Tokens are opaque
              (<code>glsp_at_</code> access, <code>glsp_rt_</code> refresh), audience-pinned, and die with the card.
            </p>
            <Table
              head={["Endpoint", "Spec"]}
              rows={[
                [<code key="o">GET /.well-known/oauth-protected-resource/mcp</code>, "RFC 9728 protected-resource metadata"],
                [<code key="o">GET /.well-known/oauth-authorization-server</code>, "RFC 8414 AS metadata"],
                [<code key="o">POST /register</code>, "RFC 7591 dynamic client registration"],
                [<code key="o">GET /authorize</code>, "Validates, then 302s to the dashboard card-picker"],
                [<code key="o">POST /token</code>, "authorization_code + refresh_token grants, PKCE S256"],
                [<code key="o">POST /revoke</code>, "RFC 7009 revocation (kills the whole token family)"],
              ]}
            />
            <h3>MCP, facilitator + demo</h3>
            <Table
              head={["Endpoint", "Purpose"]}
              rows={[
                [<code key="m">ALL /c/:secret/mcp</code>, "Lane A: secret in the path"],
                [<code key="m">ALL /mcp</code>, "Lane B (bearer) + Lane C (OAuth token)"],
                [<code key="m">GET /supported · POST /verify · /settle</code>, "The ERC-7710 x402 facilitator (under /facilitator)"],
                [<code key="m">GET /demo/premium-data</code>, "x402-protected demo seller (0.01 USDC)"],
                [<code key="m">GET /shop/products · POST /shop/checkout</code>, "The demo merchant API"],
                [<code key="m">GET /health</code>, "Liveness + engine version"],
              ]}
            />
          </Section>

          {/* ---- Self-hosting ---- */}
          <Section id="selfhost" title="Self-Hosting">
            <p className="docp">
              A Bun monorepo, three packages: <code>engine</code> (the pure card engine), <code>server</code> (Hono:
              REST + MCP + facilitator + Stripe webhook + demo shop) and <code>dashboard</code> (Next.js). Real money
              moves on Base mainnet, so use small budgets.
            </p>
            <Code code={`bun install
cp .env.example .env          # then set the two required vars below

bun dev                       # server on :4070
bun run --cwd packages/dashboard dev   # dashboard on :4071`} />
            <h3>Required environment</h3>
            <Table
              head={["Var", "Purpose"]}
              rows={[
                [<code key="e">ATTESTPAY_MASTER_KEY</code>, "32-byte hex key; encrypts agent keys + card secrets at rest"],
                [<code key="e">ATTESTPAY_ADMIN_TOKEN</code>, "Ops bearer token for the management API (server-side only)"],
                [<code key="e">ATTESTPAY_PRIVY_APP_ID</code>, "Dashboard lane: enables per-user Privy auth against the app JWKS"],
              ]}
            />
            <h3>Common optional environment</h3>
            <Table
              head={["Var", "Purpose"]}
              rows={[
                [<code key="e">ATTESTPAY_PUBLIC_MCP_BASE</code>, "Public origin for card URLs (also arms the MCP Host allowlist)"],
                [<code key="e">ATTESTPAY_CORS_ORIGINS</code>, "Comma-separated allowed origins for the API + shop"],
                [<code key="e">STRIPE_SECRET_KEY</code>, "Stripe TEST-mode key (sk_test_/rk_test_ only); enables the fiat leg"],
                [<code key="e">ATTESTPAY_STRIPE_WEBHOOK_SECRET</code>, "Real-time auth webhook secret; unset = fiat leg disabled (503)"],
                [<code key="e">ATTESTPAY_FIAT_SETTLEMENT</code>, "1 = approved Visa charges settle on-chain as real USDC"],
                [<code key="e">VENICE_API_KEY · VENICE_MODEL</code>, "Enables /cards/compile; pin the model id"],
                [<code key="e">ATTESTPAY_DASHBOARD_BASE</code>, "Dashboard origin hosting the OAuth consent page"],
                [<code key="e">ATTESTPAY_RPC_URL · NEXT_PUBLIC_BASE_RPC</code>, "Base RPC for server + client reads (default mainnet.base.org)"],
                [<code key="e">ATTESTPAY_DB_PATH</code>, "SQLite path (default .dev/attestpay.sqlite)"],
                [<code key="e">ATTESTPAY_ALLOWED_HOSTS</code>, "Extra Host headers accepted on the MCP endpoint (e.g. a platform fallback domain)"],
                [<code key="e">BASESCAN_API_KEY</code>, "Verified-contract labels from Basescan when resolving compiled drafts"],
                [<code key="e">ATTESTPAY_TRUST_PROXY_HOPS</code>, "Trusted proxy hops for client-IP rate limiting (default 1 = Railway edge)"],
                [<code key="e">ATTESTPAY_MCP_RATE_LIMIT · ATTESTPAY_MCP_BAD_SECRET_LIMIT</code>, "Per-card and per-IP-bad-secret request ceilings per minute (240 / 30)"],
                [<code key="e">ATTESTPAY_OAUTH_ACCESS_TTL · ATTESTPAY_OAUTH_REFRESH_TTL</code>, "OAuth access / refresh token lifetimes in seconds (3600 / 2592000)"],
                [<code key="e">ATTESTPAY_OAUTH_REDIRECT_HOSTS</code>, "If set, restricts OAuth https redirect-URI hosts to this allowlist (recommended in prod)"],
              ]}
            />
            <h3>Contracts (Base mainnet · chain 8453)</h3>
            <Table
              head={["Contract", "Address"]}
              rows={[
                [<code key="c">DelegationManager</code>, <code key="v">0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3</code>],
                [<code key="c">Stateless7702 delegator impl</code>, <code key="v">0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B</code>],
                [<code key="c">USDC</code>, <code key="v">0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913</code>],
              ]}
            />
          </Section>

          {/* ---- Cook Off ---- */}
          <Section id="cookoff" title="The Cook Off">
            <p className="docp">
              AttestPay was built for the MetaMask Smart Accounts Kit × 1Shot API × Venice AI Dev Cook Off. The hard gate,
              Smart Accounts Kit in the main flow, is the product itself: every card is a SAK delegation, signed by a
              Privy-provisioned embedded smart account, and every spend redeems it on-chain.
            </p>
            <Table
              head={["Track", "What AttestPay does"]}
              rows={[
                ["x402 + ERC-7710", "paid_fetch pays HTTP 402 through the card's 7710 delegation; real x402 v2 on Base mainnet"],
                ["Best Agent experience", "One URL is the whole integration; typed refusals; an OAuth lane for consent UX"],
                ["Agent-to-agent", "issue_subcard redelegates narrower authority; revoke + nuke kill whole subtrees in one signature"],
                ["Venice AI", "The issue modal compiles plain language into signed card terms (model names, registry resolves)"],
                ["1Shot Relayer", "Every redemption rides the 1Shot Public Relayer, gasless, fees in USDC"],
              ]}
            />
            <Note>
              AttestPay uses programmatic <b>ERC-7710 Delegations</b>, not ERC-7715 Advanced Permissions: the 7710 caveat
              set is richer than the 7715 grant catalog allows, so there is no{" "}
              <code>wallet_requestExecutionPermissions</code> path.
            </Note>
            <h3>Where in the code</h3>
            <p className="docp">
              Direct links into the public repo for each track, following the MetaMask DevRel submission guideline.
            </p>
            <ul className="docul">
              <li className="docli">
                <b>Delegations.</b> Create:{" "}
                <a href="https://github.com/s0nderlabs/remit/blob/main/packages/engine/src/issuance.ts#L53" target="_blank" rel="noreferrer">
                  <code>issueRootCard</code>
                </a>{" "}
                (caveats via{" "}
                <a href="https://github.com/s0nderlabs/remit/blob/main/packages/engine/src/compiler.ts#L270" target="_blank" rel="noreferrer">
                  <code>compileCard</code>
                </a>
                ). Redeem:{" "}
                <a href="https://github.com/s0nderlabs/remit/blob/main/packages/engine/src/spend.ts#L582" target="_blank" rel="noreferrer">
                  <code>spend.ts</code>
                </a>
                .
              </li>
              <li className="docli">
                <b>Redelegation (A2A).</b>{" "}
                <a href="https://github.com/s0nderlabs/remit/blob/main/packages/engine/src/issuance.ts#L225" target="_blank" rel="noreferrer">
                  <code>issueSubCard</code>
                </a>{" "}
                attenuates the parent and builds a child delegation bound to the parent&apos;s hash.
              </li>
              <li className="docli">
                <b>x402.</b> Server:{" "}
                <a href="https://github.com/s0nderlabs/remit/blob/main/packages/server/src/facilitator/routes.ts#L51" target="_blank" rel="noreferrer">
                  <code>facilitatorRoutes</code>
                </a>
                . Client (erc7710 asset transfer):{" "}
                <a href="https://github.com/s0nderlabs/remit/blob/main/packages/engine/src/x402.ts#L64" target="_blank" rel="noreferrer">
                  <code>buildX402Payload</code>
                </a>
                .
              </li>
              <li className="docli">
                <b>1Shot.</b> Every redemption rides the relayer:{" "}
                <a href="https://github.com/s0nderlabs/remit/blob/main/packages/engine/src/relayer.ts#L135" target="_blank" rel="noreferrer">
                  <code>Relayer.send</code>
                </a>{" "}
                (<code>relayer_send7710Transaction</code>).
              </li>
              <li className="docli">
                <b>Venice.</b>{" "}
                <a href="https://github.com/s0nderlabs/remit/blob/main/packages/server/src/venice/client.ts#L20" target="_blank" rel="noreferrer">
                  <code>veniceChat</code>
                </a>{" "}
                orchestrated by{" "}
                <a href="https://github.com/s0nderlabs/remit/blob/main/packages/server/src/venice/compiler.ts#L98" target="_blank" rel="noreferrer">
                  <code>compileIntent</code>
                </a>
                .
              </li>
            </ul>
            <hr className="docrule" />
            <p className="docp">
              Ready to issue one? <Link href="/">Open the dashboard</Link>, sign in, and your first card takes about a
              minute.
            </p>
          </Section>
        </div>
      </main>
    </div>
  );
}
