import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Inter, Roboto_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

// The type system, three voices: Bricolage Grotesque 800 for display headlines
// and display numerals (positive tracking, chunky, sticker-like — never below
// 40px for prose), Inter for everything functional, Roboto Mono for micro-labels,
// hex and technical metadata. The variable names survive from the previous
// system so every existing rule keeps resolving.
const display = Bricolage_Grotesque({ weight: ["700", "800"], subsets: ["latin"], variable: "--font-display", display: "swap" });
const sans = Inter({ weight: ["400", "500", "600", "700"], subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = Roboto_Mono({ weight: ["400", "500"], subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: "AttestPay — spending cards for AI agents", template: "%s · AttestPay" },
  description:
    "Issue scoped, revocable spending cards from your wallet. Any AI agent plugs one in over MCP and pays within your limits; every payment is proven onto Creditcoin.",
  openGraph: {
    title: "AttestPay — spending cards for AI agents",
    description: "Give your agent a card, not your keys. Scoped, revocable, proven cross-chain.",
    type: "website",
  },
};

// Mobile correctness: explicit viewport (edge-to-edge on notched phones). The
// input-focus zoom on iOS is prevented at the CSS layer (16px controls on
// coarse pointers), so the viewport stays user-scalable. theme-color is OWNED
// by the inline theme script + the toggle (the app theme is the user's saved
// choice, not the OS preference · a static media-keyed meta would tint the
// browser chrome wrong for pinned themes).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

// Theme lands on <html> before first paint: saved choice wins, OS preference
// seeds the first visit. Runs inline so dark mode never flashes light. Also
// pins the theme-color meta (browser chrome tint) to the ACTIVE theme · the
// toggle keeps it in sync afterwards.
const themeInit = `(function(){var t="light";try{t=localStorage.getItem("attestpay-theme");if(t!=="dark"&&t!=="light"){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}}catch(e){t="light";}document.documentElement.dataset.theme=t;var m=document.querySelector('meta[name="theme-color"]');if(!m){m=document.createElement("meta");m.setAttribute("name","theme-color");document.head.appendChild(m);}m.setAttribute("content",t==="dark"?"#142408":"#fcfaf5");})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
