import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next 16 writes AGENTS.md / CLAUDE.md into the package on dev; the repo keeps its own.
  agentRules: false,
  reactStrictMode: true,
  // Dev-only: Next blocks /_next/* dev resources from non-localhost origins by
  // default, which leaves a phone on the LAN stuck on the SSR shell (no
  // hydration, no error · the "infinite Loading…" trap). Allow private-network
  // hosts so dev-on-a-phone bootstraps; production ignores this setting.
  allowedDevOrigins: ["192.168.1.*", "10.0.0.*"],
};

export default nextConfig;
