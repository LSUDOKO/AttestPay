"use client";

// The sign-in screen, sketchbook edition. Split title page: the type column
// toward the centre (badge, display headline with a highlighted word, the lede,
// the CTA stack); the REAL dashboard card (Visa face) resting tilted on a mint
// sticky-note on the right. The card's woven guilloche flows only under the
// pointer (the dashboard grammar). Hand-drawn marks carry the atmosphere.
// The Boot overlay exits over this.

import { useState } from "react";
import Link from "next/link";
import { useLoginWithOAuth } from "@privy-io/react-auth";
import { ChipDots, Guilloche } from "./ui";
import { Logo } from "./Logo";
import { SketchArrow, SketchStar } from "./Sketch";
import s from "./login.module.css";

function GoogleConnect() {
  const { initOAuth } = useLoginWithOAuth();
  return (
    <button className={`pastel teal ${s.cta} ${s.google}`} onClick={() => initOAuth({ provider: "google" })}>
      Continue with Google
    </button>
  );
}

export function Login({ onLogin }: { onLogin: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <main className={s.stage} data-testid="login-screen">
      <div className={s.brand}>
        <Logo href="/" />
      </div>
      <Link className={s.docslink} href="/docs">
        Docs
      </Link>

      <section className={s.type}>
        <span className={`rv ${s.badge}`} style={{ animationDelay: ".05s" }}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M9 1.5 3.5 9h4l-1 5.5L12 7H8z" />
          </svg>
          The dashboard
        </span>
        <h1 className={`rv ${s.wm}`} style={{ animationDelay: ".1s" }}>
          Authority, <span className="hl wash">lent</span> not given.
        </h1>
        <p className={`rv ${s.tag}`} style={{ animationDelay: ".18s" }}>
          Scoped, revocable spending cards for your agents.
        </p>
        <p className={`rv ${s.lede}`} style={{ animationDelay: ".24s" }}>
          They borrow authority within your terms, never hold funds, and die on revoke. Every payment is proven onto
          Creditcoin as public, checkable credit history.
        </p>
        <p className={`rv ${s.quiet}`} style={{ animationDelay: ".3s" }}>
          Sign in with email or Google · no seed phrase
        </p>
        <span className={`rv ${s.ctarow}`} style={{ animationDelay: ".36s" }}>
          <button className={`primary arrow ${s.cta}`} onClick={onLogin} data-testid="login">
            Sign in
          </button>
          <GoogleConnect />
        </span>
        <div className={`rv ${s.backed}`} style={{ animationDelay: ".44s" }}>
          <b>Built on:</b>
          <span>Base</span>
          <span>ERC-7710</span>
          <span>x402</span>
          <span>Creditcoin</span>
          <span>MCP</span>
        </div>
      </section>

      <section className={s.counter} aria-hidden>
        <div className={`rv ${s.frame}`} style={{ animationDelay: ".3s" }}>
          <SketchStar className={s.sk1} size={72} />
          <SketchArrow className={s.sk2} size={130} />
          <div className={s.sticky} />
          <div className={s.tilt} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
            <div className={`card ${s.cardobj}`}>
              <div className="band">
                <Guilloche width={472} height={88} animate={hover} />
              </div>
              <div className="inner">
                <div className="row1">
                  <span className="wm">attestpay</span>
                  <span className="ctag">live</span>
                </div>
                <ChipDots />
                <div className="num">
                  <span>4000</span>
                  <span>0099</span>
                  <span>9000</span>
                  <span>0013</span>
                  <span className="brandmark">Visa</span>
                </div>
                <div className="holderline">
                  <span className="hname">Agent Card</span>
                  <span className="hexp">04/29</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
