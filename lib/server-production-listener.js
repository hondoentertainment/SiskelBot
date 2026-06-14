import { createServer } from "node:http";
import { attachToServer, closeServer } from "./realtime.js";
import { mountRealtimeWs } from "../routes/realtime-ws.js";
import { defaultChannelRegistry } from "./realtime-channels.js";
import { buildRunIndexFromSessions } from "./agent-session.js";
import { globalEmbeddingCache } from "./embedding-cache.js";
import { initLogShipping } from "./log-shipper.js";
import { initTracing } from "./tracing.js";
import { start as schedulerStart, stop as schedulerStop } from "./scheduler.js";
import { startPromptEvolutionScheduler } from "./prompt-evolution.js";
import { getSyntheticMonitor, registerBuiltInChecks } from "./synthetic-monitor.js";
import { startDailySecurityScan } from "./security-scorecard.js";

const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 10_000;

/**
 * HTTP listen, WebSocket upgrade, OTEL, graceful shutdown — omitted on Vercel.
 * @param {import("express").Express} app
 * @param {{ PORT: number|string; BACKEND: string; VLLM_URL: string; OLLAMA_URL: string; installRealtimeMetricsHooks: Function }} runtime — must come from the same server-configured-app.js graph as `app`
 */
export function attachProductionListener(app, runtime) {
  const { PORT, BACKEND, VLLM_URL, OLLAMA_URL, installRealtimeMetricsHooks } = runtime;
  initLogShipping();
  initTracing()
    .catch(() => {})
    .then(() => {
      const httpServer = createServer(app);
      attachToServer(httpServer);
      if (process.env.REALTIME_WS_DISABLED !== "1") {
        mountRealtimeWs(httpServer, { channels: defaultChannelRegistry });
      }
      installRealtimeMetricsHooks(defaultChannelRegistry);
      buildRunIndexFromSessions()
        .then((stats) => {
          if (stats?.runs > 0) {
            console.log(
              `[boot] agent-session run index: ${stats.runs} runs across ${stats.sessions} sessions`,
            );
          }
        })
        .catch((err) => console.warn("[boot] buildRunIndexFromSessions failed:", err.message));

      function gracefulShutdown(signal) {
        console.log(`[shutdown] Received ${signal}, shutting down gracefully...`);
        httpServer.close(async () => {
          try {
            if (process.env.ENABLE_SCHEDULED_RECIPES === "1") schedulerStop();
            if (process.env.ENABLE_SYNTHETIC_MONITORING === "1") {
              try {
                getSyntheticMonitor().stop();
              } catch (_) {}
            }
            if (process.env.EMBEDDING_CACHE_PATH) {
              try {
                await globalEmbeddingCache.persist(process.env.EMBEDDING_CACHE_PATH);
                console.log(`[shutdown] Persisted embedding cache to ${process.env.EMBEDDING_CACHE_PATH}`);
              } catch (e) {
                console.warn("[shutdown] Embedding cache persist failed:", e.message);
              }
            }
            await closeServer();
            console.log("[shutdown] Graceful shutdown complete");
            process.exit(0);
          } catch (e) {
            console.error("[shutdown] Error during shutdown:", e.message);
            process.exit(1);
          }
        });
        setTimeout(() => {
          console.error("[shutdown] Forced exit after timeout");
          process.exit(1);
        }, SHUTDOWN_TIMEOUT_MS).unref();
      }

      process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
      process.on("SIGINT", () => gracefulShutdown("SIGINT"));

      const listenHost = process.env.LISTEN_HOST?.trim() || undefined;
      const onListen = () => {
        console.log(`Proxy: http://localhost:${PORT}`);
        console.log(`Backend: ${BACKEND}`);
        if (BACKEND === "vllm") console.log(`vLLM:  ${VLLM_URL}`);
        if (BACKEND === "ollama") console.log(`Ollama: ${OLLAMA_URL}`);
        if (BACKEND === "openai") console.log(`OpenAI: api.openai.com (key set)`);
        if (process.env.ENABLE_SCHEDULED_RECIPES === "1") {
          schedulerStart().catch((e) => console.warn("[scheduler] Start failed:", e.message));
        }
        if (process.env.ENABLE_PROMPT_EVOLUTION === "1") {
          try {
            startPromptEvolutionScheduler();
            console.log("Phase 32.2: Prompt evolution auto-promotion enabled (hourly)");
          } catch (e) {
            console.warn("[prompt-evolution] Start failed:", e.message);
          }
        }
        if (process.env.ENABLE_SYNTHETIC_MONITORING === "1") {
          try {
            const monitor = getSyntheticMonitor();
            const host = process.env.LISTEN_HOST?.trim() || "127.0.0.1";
            const baseUrl = process.env.SYNTHETIC_MONITOR_BASE_URL || `http://${host}:${PORT}`;
            registerBuiltInChecks(monitor, baseUrl);
            const intervalMs = Number(process.env.SYNTHETIC_MONITOR_INTERVAL_MS) || 5 * 60 * 1000;
            monitor.start(intervalMs);
            console.log(`Phase 31.3: Synthetic monitoring enabled (interval=${intervalMs}ms, base=${baseUrl})`);
          } catch (e) {
            console.warn("[synthetic-monitor] Start failed:", e.message);
          }
        }
        if (process.env.ENABLE_SECURITY_SCORECARD !== "0") {
          try {
            startDailySecurityScan().catch((e) =>
              console.warn("[security-scorecard] Start failed:", e.message),
            );
            console.log("Phase 36.5: Security scorecard daily scan enabled");
          } catch (e) {
            console.warn("[security-scorecard] Start failed:", e.message);
          }
        }
        console.log("Phase 33: WebSocket real-time sync enabled at /ws");
        console.log("Phase 34: Health probes at /health/live, /health/ready");
      };
      if (listenHost) {
        httpServer.listen(PORT, listenHost, onListen);
      } else {
        httpServer.listen(PORT, onListen);
      }
    });
}
