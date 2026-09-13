import Link from "next/link";
import { Logo } from "./components/Logo";

// A branded dead end: the same voice as the landing page, two ways back.
export default function NotFound() {
  return (
    <main className="narrow" style={{ textAlign: "center", paddingTop: 96 }}>
      <div style={{ display: "flex", justifyContent: "center" }}>
        <Logo href="/" size="lg" />
      </div>
      <h1 className="lph1" style={{ fontSize: "clamp(40px, 6vw, 66px)", marginTop: 36 }}>
        Nothing <span className="hl">here</span>.
      </h1>
      <p className="lpsub" style={{ marginTop: 18 }}>
        That page does not exist, or the card it pointed at is gone. Cards that were revoked or deleted stay in the
        audit log.
      </p>
      <div className="lpctas">
        <Link className="abtn primary arrow" href="/app">
          Open the dashboard
        </Link>
        <Link className="abtn pastel" href="/docs">
          Read the docs
        </Link>
      </div>
    </main>
  );
}
