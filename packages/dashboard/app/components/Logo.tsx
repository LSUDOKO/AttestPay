// The logo lockup: a highlighter-yellow square carrying a hand-drawn "ap"
// monogram in forest ink (rounded, deliberately imperfect strokes), followed by
// the wordmark in Inter 700. One component, three sizes, used by every nav.

import Link from "next/link";

export function Monogram({ size = 36 }: { size?: number }) {
  return (
    <span className="lgmark" style={{ width: size, height: size }} aria-hidden>
      <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
        {/* a: a loose bowl with a tail that overshoots */}
        <path d="M17.5 17.2c-2.4-1.6-6.4-.4-7.1 3.6-.6 3.6 2.1 6.4 5 5.6 2.1-.6 3-2.6 3.1-4.4M18.4 15.8c-.2 4.3-.1 8.2.4 10.4" />
        {/* p: a stem that dips below, bowl slightly open */}
        <path d="M23.2 16.1c.3 5.2.1 10.6-.6 15.4M23.4 18.2c1.4-2.4 5.5-2.7 6.7.9 1.1 3.3-1.3 6.9-4.6 6.4-1-.2-1.8-.9-2.4-1.6" />
      </svg>
    </span>
  );
}

export function Logo({ href = "/", size = "md" }: { href?: string; size?: "sm" | "md" | "lg" }) {
  const px = size === "lg" ? 44 : size === "sm" ? 30 : 36;
  return (
    <Link className={`logo logo-${size}`} href={href} aria-label="AttestPay">
      <Monogram size={px} />
      <span className="lgword">AttestPay</span>
    </Link>
  );
}
