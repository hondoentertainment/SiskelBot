/**
 * Phase 54: Optional OpenTelemetry — OTEL_ENABLED=1, OTEL_EXPORTER_OTLP_ENDPOINT.
 * Phase 47: HTTP (incoming/outgoing) + Undici (global fetch) auto-instrumentation when OTEL_AUTO_INSTRUMENT≠0.
 */
let _inited = false;

export async function initTracing() {
  if (_inited || process.env.OTEL_ENABLED !== "1") return;
  try {
    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
    const { Resource } = await import("@opentelemetry/resources");

    const exporter = new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318/v1/traces",
    });

    const instrumentations = [];
    if (process.env.OTEL_AUTO_INSTRUMENT !== "0") {
      try {
        const { HttpInstrumentation } = await import("@opentelemetry/instrumentation-http");
        instrumentations.push(
          new HttpInstrumentation({
            ignoreIncomingRequestHook: (req) => {
              const u = req.url || "";
              if (u.startsWith("/health/live")) return true;
              if (u.startsWith("/metrics")) return true;
              return false;
            },
          })
        );
      } catch (e) {
        console.warn("[otel] HttpInstrumentation unavailable:", e.message);
      }
      try {
        const { UndiciInstrumentation } = await import("@opentelemetry/instrumentation-undici");
        instrumentations.push(new UndiciInstrumentation());
      } catch (e) {
        console.warn("[otel] UndiciInstrumentation unavailable:", e.message);
      }
    }

    const sdk = new NodeSDK({
      resource: new Resource({
        "service.name": process.env.OTEL_SERVICE_NAME || "siskel-bot",
      }),
      traceExporter: exporter,
      instrumentations,
    });

    await sdk.start();
    _inited = true;
    console.log(
      "[otel] Tracing enabled →",
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318/v1/traces",
      instrumentations.length ? `(${instrumentations.length} instrumentations)` : "(no auto-instrumentation)"
    );
  } catch (e) {
    console.warn("[otel] Failed to start:", e.message);
  }
}
