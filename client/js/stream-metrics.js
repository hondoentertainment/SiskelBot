/**
 * Streaming UX metrics — tracks token throughput, time-to-first-token,
 * and renders a live status bar below the chat input.
 */
(function (global) {

  function createStreamMetrics() {
    var tokenCount = 0;
    var firstTokenTime = null;
    var startTime = null;
    var endTime = null;
    var modelName = null;
    var containerEl = null;
    var barEl = null;
    var rafId = null;
    var done = false;

    function onToken(text) {
      if (!startTime) startTime = performance.now();
      if (!text) return;
      // Approximate token count: split on whitespace and punctuation boundaries
      // A simple heuristic: count roughly 1 token per 4 chars (GPT-like)
      // But for display we count text chunks received as ~1 token per call
      tokenCount++;
      if (firstTokenTime === null) {
        firstTokenTime = performance.now();
      }
      scheduleUpdate();
    }

    function onDone(opts) {
      done = true;
      endTime = performance.now();
      if (opts && opts.model) modelName = opts.model;
      scheduleUpdate();
    }

    function setModel(name) {
      modelName = name;
    }

    function getStats() {
      var now = endTime || performance.now();
      var totalMs = startTime ? now - startTime : 0;
      var ttft = (firstTokenTime && startTime) ? Math.round(firstTokenTime - startTime) : null;
      var tokPerSec = totalMs > 0 ? (tokenCount / (totalMs / 1000)) : 0;
      return {
        tokens: tokenCount,
        timeToFirstTokenMs: ttft,
        tokensPerSecond: Math.round(tokPerSec * 10) / 10,
        totalDurationMs: Math.round(totalMs),
        totalDurationSec: Math.round(totalMs / 100) / 10,
        model: modelName,
        done: done
      };
    }

    function formatBar(stats) {
      var parts = [];
      parts.push(stats.tokens + ' token' + (stats.tokens !== 1 ? 's' : ''));
      if (stats.tokensPerSecond > 0) parts.push(stats.tokensPerSecond + ' tok/s');
      parts.push(stats.totalDurationSec + 's');
      if (stats.done && stats.model) parts.push('Model: ' + stats.model);
      var prefix = stats.done ? 'Done: ' : 'Streaming: ';
      return prefix + parts.join(' | ');
    }

    function scheduleUpdate() {
      if (rafId) return;
      rafId = requestAnimationFrame(function () {
        rafId = null;
        updateBar();
      });
    }

    function updateBar() {
      if (!barEl) return;
      var stats = getStats();
      barEl.textContent = formatBar(stats);
      barEl.classList.toggle('stream-metrics-done', done);
      barEl.classList.toggle('stream-metrics-active', !done);
    }

    function render(el) {
      containerEl = el;
      if (!containerEl) return;
      barEl = containerEl.querySelector('.stream-metrics-bar');
      if (!barEl) {
        barEl = document.createElement('div');
        barEl.className = 'stream-metrics-bar stream-metrics-active';
        containerEl.appendChild(barEl);
      }
      updateBar();
    }

    function destroy() {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = null;
      if (barEl && barEl.parentNode) barEl.parentNode.removeChild(barEl);
      barEl = null;
    }

    return {
      onToken: onToken,
      onDone: onDone,
      setModel: setModel,
      getStats: getStats,
      render: render,
      destroy: destroy
    };
  }

  function renderMetricsBar(stats, parentEl) {
    if (!parentEl) return;
    var existing = parentEl.querySelector('.stream-metrics-bar');
    if (existing) existing.remove();

    var bar = document.createElement('div');
    bar.className = 'stream-metrics-bar' + (stats.done ? ' stream-metrics-done' : ' stream-metrics-active');

    var parts = [];
    parts.push(stats.tokens + ' token' + (stats.tokens !== 1 ? 's' : ''));
    if (stats.tokensPerSecond > 0) parts.push(stats.tokensPerSecond + ' tok/s');
    parts.push(stats.totalDurationSec + 's');
    if (stats.done && stats.model) parts.push('Model: ' + stats.model);
    var prefix = stats.done ? 'Done: ' : 'Streaming: ';
    bar.textContent = prefix + parts.join(' | ');

    parentEl.appendChild(bar);
  }

  // Inject styles
  var styleId = 'stream-metrics-styles';
  if (typeof document !== 'undefined' && !document.getElementById(styleId)) {
    var style = document.createElement('style');
    style.id = styleId;
    style.textContent = [
      '.stream-metrics-bar {',
      '  font-family: "SF Mono", "Fira Code", "Cascadia Code", Consolas, monospace;',
      '  font-size: 0.7rem;',
      '  padding: 0.3rem 0.65rem;',
      '  color: #64748b;',
      '  background: #0f172a;',
      '  border: 1px solid #1e293b;',
      '  border-radius: 4px;',
      '  margin: 0.35rem 0 0;',
      '  letter-spacing: 0.02em;',
      '  transition: color 0.2s, border-color 0.2s;',
      '}',
      '.stream-metrics-active {',
      '  color: #7dd3fc;',
      '  border-color: #334155;',
      '}',
      '.stream-metrics-done {',
      '  color: #64748b;',
      '  border-color: #1e293b;',
      '}'
    ].join('\n');
    document.head.appendChild(style);
  }

  if (typeof global !== 'undefined') {
    global.SiskelStreamMetrics = {
      createStreamMetrics: createStreamMetrics,
      renderMetricsBar: renderMetricsBar
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
