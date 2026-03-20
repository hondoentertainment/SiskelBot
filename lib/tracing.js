/**
 * Phase 54: Optional OpenTelemetry — OTEL_ENABLED=1, OTEL_EXPORTER_OTLP_ENDPOINT (default http://localhost:4318/v1/traces).
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

    const sdk = new NodeSDK({
      resource: new Resource({
        "service.name": process.env.OTEL_SERVICE_NAME || "bond",
      }),
      traceExporter: exporter,
      instrumentations: [],
    });

    await sdk.start();
    _inited = true;
    console.log("[otel] Tracing enabled →", process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318/v1/traces");
  } catch (e) {
    console.warn("[otel] Failed to start:", e.message);
  }
}
