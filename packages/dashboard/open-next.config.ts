// OpenNext adapter config for Cloudflare Workers.
//
// Why OpenNext and not `output: "export"`: the dashboard has a genuinely dynamic route
// (`/card/[id]`, where the id is a runtime card id), which a static export cannot
// pre-render — it refuses to build without `generateStaticParams()`, and card ids are
// not knowable at build time. OpenNext runs the real Next server on Workers, so the
// route keeps its URL shape.
//
// No incremental cache is configured: every page in this app is a client component that
// fetches from the API at runtime, so there is no ISR payload worth caching. Adding an
// R2 cache here would buy nothing and cost a binding.
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig();
