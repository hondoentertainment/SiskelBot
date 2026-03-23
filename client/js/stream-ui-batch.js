/**
 * Coalesces rapid UI updates to one requestAnimationFrame (streaming SSE, agent progress).
 * Phase: client performance — path-to-100 modular helper (loaded before inline app script).
 */
(function (global) {
  function createRafBatcher() {
    let scheduled = false;
    var pending = null;
    return function batch(fn) {
      pending = fn;
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(function () {
          scheduled = false;
          var cb = pending;
          pending = null;
          if (cb) {
            try {
              cb();
            } catch (_) {}
          }
        });
      }
    };
  }
  global.SiskelRafBatcher = { create: createRafBatcher };
})(typeof window !== "undefined" ? window : globalThis);
