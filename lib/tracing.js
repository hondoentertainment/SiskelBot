/**
 * Phase 54: Optional OpenTelemetry — OTEL_ENABLED=1, OTEL_EXPORTER_OTLP_ENDPOINT.
 * Phase 47: HTTP + Undici auto-instrumentation when OTEL_AUTO_INSTRUMENT≠0.
 * Phase 69: Pg instrumentation, head-based sampling envs, richer resource attributes.
 */
let _inited = false;

/**
 * Build head-based root sampler from env (OpenTelemetry–style + OTEL_TRACE_SAMPLING_RATIO).
 * Tail sampling is not done in-process; use an OTEL Collector tail sampler.
 * @returns {import('@opentelemetry/sdk-trace-base').Sampler | undefined}
 */
async function buildSamplerFromEnv() {
  const { ParentBasedSampler, TraceIdRatioBasedSampler, AlwaysOnSampler, AlwaysOffSampler } = await import(
    "@opentelemetry/sdk-trace-base"
  );

  const explicit = (process.env.OTEL_TRACES_SAMPLER || "").trim().toLowerCase();
  const ratioRaw = process.env.OTEL_TRACE_SAMPLING_RATIO ?? process.env.OTEL_TRACES_SAMPLER_ARG;
  const ratioNum = ratioRaw != null && ratioRaw !== "" ? Number(ratioRaw) : NaN;

  if (explicit === "always_off") {
    return new ParentBasedSampler({ root: new AlwaysOffSampler() });
  }
  if (explicit === "always_on" || explicit === "parentbased_always_on") {
    return new ParentBasedSampler({ root: new AlwaysOnSampler() });
  }
  if (explicit === "traceidratio" || explicit === "parentbased_traceidratio") {
    const r = Number.isFinite(ratioNum) ? Math.min(1, Math.max(0, ratioNum)) : 1;
    if (r <= 0) return new ParentBasedSampler({ root: new AlwaysOffSampler() });
    if (r >= 1) return new ParentBasedSampler({ root: new AlwaysOnSampler() });
    return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(r) });
  }

  if (Number.isFinite(ratioNum)) {
    const r = Math.min(1, Math.max(0, ratioNum));
    if (r <= 0) return new ParentBasedSampler({ root: new AlwaysOffSampler() });
    if (r >= 1) return undefined;
    return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(r) });
  }

  return undefined;
}

export async function initTracing() {
  if (_inited || process.env.OTEL_ENABLED !== "1") return;
  try {
    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
    const { Resource } = await import("@opentelemetry/resources");
    const { createTraceExplorerSpanProcessor } = await import("./tracing-spans.js");

    const exporter = new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318/v1/traces",
    });

    const explorerProcessor = createTraceExplorerSpanProcessor();

    const instrumentations = [];
    const autoOn = process.env.OTEL_AUTO_INSTRUMENT !== "0";
    if (autoOn) {
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
      if (process.env.OTEL_PG_INSTRUMENT !== "0") {
        try {
          const { PgInstrumentation } = await import("@opentelemetry/instrumentation-pg");
          instrumentations.push(
            new PgInstrumentation({
              enhancedDatabaseReporting: process.env.OTEL_PG_ENHANCED === "1",
            })
          );
        } catch (e) {
          console.warn("[otel] PgInstrumentation unavailable:", e.message);
        }
      }
    }

    const sampler = await buildSamplerFromEnv();

    const resourceAttrs = {
      "service.name": process.env.OTEL_SERVICE_NAME || "siskel-bot",
    };
    const ver = process.env.OTEL_SERVICE_VERSION || process.env.npm_package_version;
    if (ver) resourceAttrs["service.version"] = String(ver);

    const sdkConfig = {
      resource: new Resource(resourceAttrs),
      traceExporter: exporter,
      instrumentations,
    };
    if (sampler) sdkConfig.sampler = sampler;
    if (explorerProcessor) sdkConfig.spanProcessors = [explorerProcessor];

    const sdk = new NodeSDK(sdkConfig);

    await sdk.start();
    _inited = true;
    const ratioHint =
      process.env.OTEL_TRACE_SAMPLING_RATIO ||
      process.env.OTEL_TRACES_SAMPLER_ARG ||
      process.env.OTEL_TRACES_SAMPLER ||
      "default";
    console.log(
      "[otel] Tracing enabled →",
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318/v1/traces",
      instrumentations.length ? `(${instrumentations.length} instrumentations)` : "(no auto-instrumentation)",
      sampler ? `sampler=${ratioHint}` : "",
      explorerProcessor ? "trace-explorer=on" : ""
    );
  } catch (e) {
    console.warn("[otel] Failed to start:", e.message);
  }
}
