"use client";

// /shop: standalone demo merchant ("s0nder supply co."), a sibling storefront
// on the remit design system (same tokens, light + INK dark) with an honest
// foot note: test-mode Visa, real on-chain settlement. An agent fills the
// checkout form via browser automation (data-testids below), the fiat lane
// authorizes behind the scenes. No Privy, no dashboard chrome - plain fetch
// against the server's public /shop routes. Also served at the shop.* host
// (proxy.ts rewrites it here).

import { useEffect, useState } from "react";
import { shopApiBase } from "./api-base";
import s from "./shop.module.css";

const BASE = shopApiBase(process.env.NEXT_PUBLIC_ATTESTPAY_API);

type Product = { id: string; name: string; price: string; description?: string | null };
type Catalog = { merchant: string; products: Product[] };
type CheckoutResult = {
  approved: boolean;
  reason: string;
  authorization_id?: string;
  product?: Product;
  last4?: string;
};

export default function ShopPage() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [stripeCatalog, setStripeCatalog] = useState<Catalog | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [stripeLoadErr, setStripeLoadErr] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"s0nder" | "stripe">("s0nder");

  const [picked, setPicked] = useState<Product | null>(null);
  const [number, setNumber] = useState("");
  const [expMonth, setExpMonth] = useState("");
  const [expYear, setExpYear] = useState("");
  const [cvc, setCvc] = useState("");
  const [paying, setPaying] = useState(false);
  const [result, setResult] = useState<CheckoutResult | null>(null);
  const [payErr, setPayErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${BASE}/shop/products`, { cache: "no-store" });
        if (!res.ok) throw new Error(`http ${res.status}`);
        setCatalog((await res.json()) as Catalog);
      } catch (e) {
        setLoadErr(e instanceof Error ? e.message : String(e));
      }
    })();
    (async () => {
      try {
        const res = await fetch(`${BASE}/shop/stripe-products`, { cache: "no-store" });
        if (res.ok) {
          setStripeCatalog((await res.json()) as Catalog);
        }
      } catch (e) {
        setStripeLoadErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  // keep the browser tab in character (root layout titles the attestpay dashboard)
  useEffect(() => {
    document.title = catalog?.merchant ?? "s0nder supply co.";
  }, [catalog]);

  const pick = (p: Product) => {
    setPicked(p);
    setResult(null);
    setPayErr(null);
  };

  const pay = async () => {
    if (!picked) return;
    setPaying(true);
    setPayErr(null);
    const endpoint =
      activeTab === "stripe" && stripeCatalog?.products.some((p) => p.id === picked.id)
        ? `${BASE}/shop/stripe-checkout`
        : `${BASE}/shop/checkout`;
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          product_id: picked.id,
          card: { number, exp_month: Number(expMonth), exp_year: Number(expYear), cvc },
        }),
      });
      // declines come back 200 { approved: false }; only malformed/disabled are non-2xx
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.reason ?? body?.error ?? `http ${res.status}`);
      setResult(body as CheckoutResult);
    } catch (e) {
      setPayErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPaying(false);
    }
  };

  const tryAgain = () => {
    setResult(null);
    setPayErr(null);
  };

  const formReady = number.trim() !== "" && expMonth.trim() !== "" && expYear.trim() !== "" && cvc.trim() !== "";

  const activeCatalog = activeTab === "stripe" ? stripeCatalog : catalog;
  const activeMerchant =
    activeTab === "stripe"
      ? stripeCatalog?.merchant ?? "attestpay marketplace"
      : catalog?.merchant ?? "s0nder supply co.";
  const products = activeCatalog?.products ?? [];

  return (
    <div className={s.wrap}>
      <div className={s.inner}>
        <div className={s.brand}>{activeMerchant}</div>
        <div className={s.tag}>
          {activeTab === "stripe"
            ? "Digital goods from the Stripe catalog."
            : "Everyday goods, shipped fast."}
        </div>

        {/* Store tabs */}
        <div className={s.tabs}>
          <button
            className={`${s.tab} ${activeTab === "s0nder" ? s.tabActive : ""}`}
            onClick={() => { setActiveTab("s0nder"); setPicked(null); setResult(null); setPayErr(null); }}
          >
            s0nder supply co.
          </button>
          {stripeCatalog && (
            <button
              className={`${s.tab} ${activeTab === "stripe" ? s.tabActive : ""}`}
              onClick={() => { setActiveTab("stripe"); setPicked(null); setResult(null); setPayErr(null); }}
            >
              Stripe Marketplace
            </button>
          )}
        </div>

        {loadErr && activeTab === "s0nder" && (
          <p className={s.quiet}>Store is unavailable right now ({loadErr}). Refresh to retry.</p>
        )}
        {stripeLoadErr && activeTab === "stripe" && (
          <p className={s.quiet}>Stripe catalog unavailable ({stripeLoadErr}). Check Stripe env vars.</p>
        )}
        {!activeCatalog && activeTab === "s0nder" && !loadErr && (
          <div className={s.grid} aria-hidden>
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className={s.skel}>
                <i />
                <i />
                <i />
              </div>
            ))}
          </div>
        )}
        {!activeCatalog && activeTab === "stripe" && !stripeLoadErr && (
          <div className={s.grid} aria-hidden>
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className={s.skel}>
                <i />
                <i />
                <i />
              </div>
            ))}
          </div>
        )}

        {products.length > 0 && (
          <div className={s.grid}>
            {products.map((p) => (
              <div key={p.id} className={s.product}>
                <div className={s.pname}>{p.name}</div>
                {p.description && <div className={s.pdesc}>{p.description}</div>}
                <div className={s.pprice}>${p.price}</div>
                <button
                  className={picked?.id === p.id ? `${s.buy} ${s.active}` : s.buy}
                  onClick={() => pick(p)}
                  data-testid={`buy-${p.id}`}
                >
                  Buy
                </button>
              </div>
            ))}
          </div>
        )}

        {picked && (
          <div className={s.panel}>
            <div className={s.ptitle}>
              Checkout · {picked.name} · ${picked.price}
            </div>

            {result === null ? (
              <>
                <div className={s.fields}>
                  <label className={s.field}>
                    Card Number
                    <input
                      value={number}
                      onChange={(e) => setNumber(e.target.value)}
                      inputMode="numeric"
                      autoComplete="cc-number"
                      placeholder="4242 4242 4242 4242"
                      data-testid="number"
                    />
                  </label>
                  <div className={s.exprow}>
                    <label className={s.field}>
                      Exp Month
                      <input
                        value={expMonth}
                        onChange={(e) => setExpMonth(e.target.value)}
                        inputMode="numeric"
                        autoComplete="cc-exp-month"
                        placeholder="12"
                        data-testid="exp-month"
                      />
                    </label>
                    <label className={s.field}>
                      Exp Year
                      <input
                        value={expYear}
                        onChange={(e) => setExpYear(e.target.value)}
                        inputMode="numeric"
                        autoComplete="cc-exp-year"
                        placeholder="2030"
                        data-testid="exp-year"
                      />
                    </label>
                    <label className={s.field}>
                      CVC
                      <input
                        value={cvc}
                        onChange={(e) => setCvc(e.target.value)}
                        inputMode="numeric"
                        autoComplete="cc-csc"
                        placeholder="123"
                        data-testid="cvc"
                      />
                    </label>
                  </div>
                </div>
                <div className={s.payrow}>
                  <button className={s.pay} onClick={pay} disabled={!formReady || paying} data-testid="pay">
                    {paying ? "Paying…" : `Pay $${picked.price}`}
                  </button>
                </div>
                {payErr && (
                  <div className={`${s.result} ${s.declined}`} data-testid="result">
                    Something went wrong · {payErr}
                  </div>
                )}
              </>
            ) : result.approved ? (
              <>
                <div className={`${s.result} ${s.approved}`} data-testid="result">
                  Payment approved · {result.product?.name ?? picked.name}
                  {result.last4 && <> · card ending {result.last4}</>}
                  {result.authorization_id && (
                    <span className={s.authid}>Authorization {result.authorization_id}</span>
                  )}
                </div>
                <div className={s.payrow}>
                  <button className={s.again} onClick={tryAgain} data-testid="try-again">
                    Buy Something Else
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className={`${s.result} ${s.declined}`} data-testid="result">
                  Payment declined · {result.reason}
                </div>
                <div className={s.payrow}>
                  <button className={s.again} onClick={tryAgain} data-testid="try-again">
                    Try Again
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        <p className={s.foot}>
          A demo storefront. It accepts Visa cards issued by{" "}
          <a href="/" target="_blank" rel="noreferrer">
            AttestPay
          </a>{" "}
          in Stripe test mode; every charge authorizes in real time against the card&apos;s on-chain budget, and
          approved charges settle as real USDC transfers on Base.{" "}
          {stripeCatalog && (
            <>
              Your Stripe products appear in the{" "}
              <button className={s.linkBtn} onClick={() => setActiveTab("stripe")}>
                Stripe Marketplace
              </button>
              {" "}tab.
            </>
          )}
        </p>
      </div>
    </div>
  );
}
