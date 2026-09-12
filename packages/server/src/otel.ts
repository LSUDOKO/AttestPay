// OpenTelemetry initialization — MUST be loaded before any other module.
// Bun --preload ./src/otel.ts ensures this runs first so auto-instrumentation
// wraps every HTTP, fetch, and database call from the start.
//
// ALL exporters are auto-detected from environment variables:
//   OTEL_TRACES_EXPORTER=otlp          (or http/protobuf, otlp, console, etc.)
//   OTEL_METRICS_EXPORTER=otlp
//   OTEL_LOGS_EXPORTER=otlp
//   OTEL_EXPORTER_OTLP_ENDPOINT       (SigNoz Cloud or self-hosted URL)
//   OTEL_EXPORTER_OTLP_HEADERS        (SigNoz Cloud: signoz-ingestion-key=YOUR_KEY)
//
// The SDK passes env-var headers to ALL auto-detected exporters automatically,
// so a single OTEL_EXPORTER_OTLP_HEADERS applies to traces, metrics, and logs.
//
// SigNoz dashboard labels: service.name = "attestpay-server"

import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";

// Enable diagnostic logging when ATTESTPAY_OTEL_DEBUG=1
if (process.env.ATTESTPAY_OTEL_DEBUG === "1") {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
}

const sdk = new NodeSDK({
  serviceName: "attestpay-server",
  instrumentations: [
    getNodeAutoInstrumentations({
      // Disable noisy diagnostics: we add our own fine-grained spans
      "@opentelemetry/instrumentation-dns": { enabled: false },
      "@opentelemetry/instrumentation-fs": { enabled: false },
    }),
  ],
});

// Graceful shutdown on SIGTERM (Railway sends this)
process.on("SIGTERM", () => {
  sdk
    .shutdown()
    .then(() => console.log("[otel] SDK shut down"))
    .catch((err) => console.error("[otel] shutdown error", err))
    .finally(() => process.exit(0));
});

// Bun --preload requires a default export or top-level await to block
// until the SDK is ready.
try {
  await sdk.start();
  console.log("[otel] OpenTelemetry SDK started — service.name=attestpay-server");
} catch (err) {
  console.error("[otel] failed to start SDK", err);
}

export { sdk };
export { trace, context, SpanStatusCode } from "@opentelemetry/api";
export { logs, SeverityNumber } from "@opentelemetry/api-logs";
export type { Counter, UpDownCounter, Histogram } from "@opentelemetry/api";
