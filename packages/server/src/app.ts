// The app factory: ONE Hono process, hostname-routed (locked all-in-Railway shape).
//   mcp.*          -> MCP endpoints + dashboard API + webhooks
//   facilitator.*  -> erc7710 x402 facilitator + demo seller (P3)
// In dev (localhost) every route is reachable on the single host.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { ENGINE_VERSION } from "@attestpay/engine";
import type { AppDeps } from "./deps";
import { mcpRoutes } from "./mcp/routes";
import { apiRoutes } from "./api/routes";
import { facilitatorRoutes } from "./facilitator/routes";
import { oauthRoutes } from "./oauth/routes";
import { OAuthStore } from "./oauth/store";
import { sellerRoutes } from "./seller/routes";
import { stripeRoutes } from "./stripe/routes";
import { shopRoutes } from "./shop/routes";
import { publicPassportRoutes } from "./attestcoin/credit-routes";

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const otel = trace.getTracer("attestpay-server");

  // OpenTelemetry middleware: wraps every request in a root span with route pattern,
  // method, status code, and auth info. startActiveSpan makes it the ACTIVE span for
  // the whole handler, so every child span (auto-instrumented fetch/DB, mcp_tool_*,
  // stripe_webhook_auth, ...) waterfalls under it as one distributed trace in SigNoz.
  app.use("*", async (c, next) => {
    await otel.startActiveSpan(`HTTP ${c.req.method} ${c.req.routePath ?? c.req.path}`, async (span) => {
      span.setAttribute("http.method", c.req.method);
      span.setAttribute("http.url", c.req.path);
      span.setAttribute("http.route", c.req.routePath ?? c.req.path);
      try {
        await next();
      } catch (e) {
        span.recordException(e as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: e instanceof Error ? e.message : String(e) });
        throw e;
      } finally {
        span.setAttribute("http.status_code", c.res.status);
        span.end();
      }
    });
  });

  // OAuth lane storage rides the same sqlite database as the engine store
  const oauth = new OAuthStore(deps.store.db);

  app.get("/health", (c) =>
    c.json({ ok: true, engine: ENGINE_VERSION, host: c.req.header("host") ?? null }),
  );

  // dashboard API is browser-consumed (dev: localhost:4071; prod: the Vercel origin)
  app.use(
    "/api/*",
    cors({
      origin: (origin) => {
        const allowed = (process.env.ATTESTPAY_CORS_ORIGINS ?? "http://localhost:4071").split(",");
        return allowed.includes(origin) ? origin : null;
      },
      allowHeaders: ["authorization", "content-type"],
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    }),
  );

  // the demo shop is browser-consumed too (same origin list as the dashboard API)
  app.use(
    "/shop/*",
    cors({
      origin: (origin) => {
        const allowed = (process.env.ATTESTPAY_CORS_ORIGINS ?? "http://localhost:4071").split(",");
        return allowed.includes(origin) ? origin : null;
      },
      allowHeaders: ["content-type"],
      allowMethods: ["GET", "POST", "OPTIONS"],
    }),
  );

  // the credit passport is public by design (any origin may read and verify one)
  app.use("/passport/*", cors({ origin: "*", allowHeaders: ["content-type"], allowMethods: ["GET", "POST", "OPTIONS"] }));
  app.route("/", publicPassportRoutes(deps));

  app.route("/", oauthRoutes(deps, oauth));
  app.route("/", mcpRoutes(deps, oauth));
  app.route("/api", apiRoutes(deps, oauth));
  app.route("/facilitator", facilitatorRoutes(deps));
  app.route("/", stripeRoutes(deps));
  app.route("/", shopRoutes(deps));
  // the demo seller settles through OUR facilitator (same process, real HTTP)
  app.route(
    "/",
    sellerRoutes(deps, () => process.env.ATTESTPAY_FACILITATOR_BASE ?? `http://localhost:${process.env.PORT ?? 4070}/facilitator`),
  );

  return app;
}
