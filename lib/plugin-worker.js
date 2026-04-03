/**
 * Phase 17.1: Plugin Worker Thread Entry Point
 * Runs inside a worker_threads Worker with restricted globals.
 * Receives plugin code path and execution context via workerData.
 * Posts result or error back via parentPort.
 */
import { workerData, parentPort } from "worker_threads";

// Remove dangerous globals before loading plugin code
delete globalThis.process;
// Keep console for debugging but nothing else

(async () => {
  try {
    const { pluginPath, context } = workerData;
    if (!pluginPath || typeof pluginPath !== "string") {
      throw new Error("Worker missing pluginPath in workerData");
    }

    // Dynamic import of the plugin module
    const pluginModule = await import(pluginPath);

    if (typeof pluginModule.execute !== "function") {
      throw new Error("Plugin does not export an execute(context) function");
    }

    // Provide a restricted fetch that only allows HTTPS
    const safeFetch = async (url, opts) => {
      if (typeof url !== "string" || !url.startsWith("https://")) {
        throw new Error("Plugin fetch only supports HTTPS URLs");
      }
      return fetch(url, { ...opts, signal: AbortSignal.timeout(10000) });
    };

    const execContext = {
      input: context?.input ?? "",
      workspaceId: context?.workspaceId ?? null,
      userId: context?.userId ?? null,
      config: context?.config ?? {},
      fetch: safeFetch,
    };

    const result = await pluginModule.execute(execContext);

    // Validate result shape
    if (!result || typeof result !== "object" || typeof result.output !== "string") {
      throw new Error("Plugin execute() must return { output: string, metadata?: object }");
    }

    parentPort.postMessage({ ok: true, result: { output: result.output, metadata: result.metadata } });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err?.message || String(err) });
  }
})();
