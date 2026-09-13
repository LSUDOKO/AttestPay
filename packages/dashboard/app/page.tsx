// / — the public landing page. The dashboard lives at /app; the nav's primary
// action reads "Sign in" or "Open dashboard" depending on the Privy session.

import { Landing } from "./components/Landing";

export default function Home() {
  return <Landing />;
}
