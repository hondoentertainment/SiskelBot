/**
 * Agent reasoning traces — captures agent_activity SSE events and renders
 * a collapsible trace panel below the assistant message.
 */
(function (global) {
  var RESULT_TRUNCATE = 200;

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function truncate(str, max) {
    if (!str) return '';
    str = String(str);
    return str.length > max ? str.slice(0, max) + '...' : str;
  }

  function createTraceCollector() {
    var events = [];
    var iterations = 0;
    var toolCallCount = 0;
    var startTime = null;
    var endTime = null;

    function addEvent(event) {
      if (!event) return;
      if (!startTime) startTime = performance.now();
      events.push({
        type: event.type || 'unknown',
        name: event.name || event.toolName || null,
        args: event.args || event.arguments || null,
        content: event.content || event.result || null,
        durationMs: event.durationMs != null ? Number(event.durationMs) : null,
        timedOut: !!event.timedOut || !!event.timeout,
        error: event.error || event.validationError || null,
        iteration: event.iteration != null ? event.iteration : iterations,
        timestamp: performance.now()
      });

      if (event.type === 'tool_call') {
        toolCallCount++;
      }
      if (event.iteration != null && event.iteration > iterations) {
        iterations = event.iteration;
      }
      if (event.type === 'agent_activity') {
        if (event.iteration) iterations = event.iteration;
        if (event.toolCalls && event.toolCalls.length) {
          event.toolCalls.forEach(function (tc) {
            toolCallCount++;
            events.push({
              type: 'tool_call',
              name: tc.name,
              args: tc.args,
              content: tc.result || null,
              durationMs: tc.durationMs != null ? Number(tc.durationMs) : null,
              timedOut: !!tc.timedOut || !!tc.timeout,
              error: tc.error || tc.validationError || null,
              iteration: event.iteration || iterations,
              timestamp: performance.now()
            });
          });
        }
      }
    }

    function getTrace() {
      return {
        events: events.slice(),
        iterations: iterations,
        toolCallCount: toolCallCount,
        totalTimeMs: startTime ? Math.round((endTime || performance.now()) - startTime) : 0,
        startTime: startTime,
        endTime: endTime
      };
    }

    function done() {
      endTime = performance.now();
    }

    function render(containerEl) {
      done();
      renderTracePanel(getTrace(), containerEl);
    }

    return { addEvent: addEvent, getTrace: getTrace, render: render, done: done };
  }

  function buildStepsByIteration(traceData) {
    var byIter = {};
    var events = traceData.events || [];
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      if (ev.type !== 'tool_call' && ev.type !== 'tool_result') continue;
      var iter = ev.iteration || 0;
      if (!byIter[iter]) byIter[iter] = [];
      byIter[iter].push(ev);
    }
    return byIter;
  }

  function renderTracePanel(traceData, parentEl) {
    if (!parentEl) return;
    if (!traceData || !traceData.events || traceData.events.length === 0) return;

    var existing = parentEl.querySelector('.agent-trace-panel');
    if (existing) existing.remove();

    var panel = document.createElement('details');
    panel.className = 'agent-trace-panel';

    var summary = document.createElement('summary');
    summary.className = 'agent-trace-header';
    var headerText = 'Agent Trace';
    var parts = [];
    if (traceData.iterations) parts.push(traceData.iterations + ' iteration' + (traceData.iterations > 1 ? 's' : ''));
    if (traceData.toolCallCount) parts.push(traceData.toolCallCount + ' tool call' + (traceData.toolCallCount > 1 ? 's' : ''));
    if (traceData.totalTimeMs) parts.push((traceData.totalTimeMs / 1000).toFixed(1) + 's total');
    if (parts.length) headerText += ' (' + parts.join(', ') + ')';
    summary.textContent = headerText;
    panel.appendChild(summary);

    var body = document.createElement('div');
    body.className = 'agent-trace-body';

    var byIter = buildStepsByIteration(traceData);
    var iterKeys = Object.keys(byIter).sort(function (a, b) { return Number(a) - Number(b); });

    for (var k = 0; k < iterKeys.length; k++) {
      var iterNum = iterKeys[k];
      var steps = byIter[iterNum];
      var iterLabel = document.createElement('div');
      iterLabel.className = 'agent-trace-iter-label';
      iterLabel.textContent = 'Iteration ' + iterNum;
      body.appendChild(iterLabel);

      for (var s = 0; s < steps.length; s++) {
        var step = steps[s];
        var stepEl = document.createElement('div');
        stepEl.className = 'agent-trace-step';
        if (step.timedOut) stepEl.classList.add('agent-trace-timeout');
        if (step.error) stepEl.classList.add('agent-trace-error');

        var toolName = escapeHtml(step.name || 'unknown');
        var resultSummary = truncate(step.content || step.error || '', RESULT_TRUNCATE);
        var durationStr = step.durationMs != null ? ' (' + step.durationMs + 'ms)' : '';
        var timeoutBadge = step.timedOut ? ' <span class="agent-trace-timeout-badge">TIMEOUT</span>' : '';

        stepEl.innerHTML =
          '<span class="agent-trace-tool-name"><code>' + toolName + '</code>' + durationStr + timeoutBadge + '</span>' +
          (resultSummary ? '<span class="agent-trace-arrow">\u2192</span><span class="agent-trace-result">' + escapeHtml(resultSummary) + '</span>' : '');

        body.appendChild(stepEl);
      }
    }

    panel.appendChild(body);
    parentEl.appendChild(panel);
  }

  // Inject styles
  var styleId = 'agent-traces-styles';
  if (typeof document !== 'undefined' && !document.getElementById(styleId)) {
    var style = document.createElement('style');
    style.id = styleId;
    style.textContent = [
      '.agent-trace-panel {',
      '  margin: 0.5rem 0;',
      '  padding: 0;',
      '  background: #0f172a;',
      '  border: 1px solid #1e293b;',
      '  border-radius: 6px;',
      '  font-size: 0.8125rem;',
      '  color: #cbd5e1;',
      '}',
      '.agent-trace-header {',
      '  cursor: pointer;',
      '  font-weight: 600;',
      '  padding: 0.5rem 0.65rem;',
      '  color: #94a3b8;',
      '  user-select: none;',
      '}',
      '.agent-trace-header:hover { color: #e2e8f0; }',
      '.agent-trace-body {',
      '  padding: 0 0.65rem 0.5rem;',
      '  max-height: 320px;',
      '  overflow-y: auto;',
      '}',
      '.agent-trace-iter-label {',
      '  font-weight: 600;',
      '  color: #64748b;',
      '  font-size: 0.75rem;',
      '  text-transform: uppercase;',
      '  letter-spacing: 0.05em;',
      '  margin: 0.5rem 0 0.25rem;',
      '  padding-top: 0.35rem;',
      '  border-top: 1px solid #1e293b;',
      '}',
      '.agent-trace-iter-label:first-child { border-top: none; margin-top: 0; }',
      '.agent-trace-step {',
      '  display: flex;',
      '  align-items: baseline;',
      '  gap: 0.4rem;',
      '  padding: 0.25rem 0.35rem;',
      '  margin: 0.15rem 0;',
      '  background: #1e293b;',
      '  border-radius: 4px;',
      '  font-size: 0.75rem;',
      '  line-height: 1.4;',
      '  flex-wrap: wrap;',
      '}',
      '.agent-trace-step code {',
      '  color: #7dd3fc;',
      '  font-family: monospace;',
      '}',
      '.agent-trace-arrow { color: #475569; flex-shrink: 0; }',
      '.agent-trace-result {',
      '  color: #94a3b8;',
      '  word-break: break-word;',
      '  flex: 1;',
      '  min-width: 0;',
      '}',
      '.agent-trace-timeout {',
      '  border-left: 3px solid #dc2626;',
      '  background: rgba(220, 38, 38, 0.1);',
      '}',
      '.agent-trace-error {',
      '  border-left: 3px solid #b45309;',
      '  background: rgba(180, 83, 9, 0.08);',
      '}',
      '.agent-trace-timeout-badge {',
      '  color: #f87171;',
      '  font-size: 0.65rem;',
      '  font-weight: 700;',
      '  text-transform: uppercase;',
      '  letter-spacing: 0.04em;',
      '  margin-left: 0.25rem;',
      '}',
      '.agent-trace-tool-name { white-space: nowrap; }'
    ].join('\n');
    document.head.appendChild(style);
  }

  if (typeof global !== 'undefined') {
    global.SiskelAgentTraces = {
      createTraceCollector: createTraceCollector,
      renderTracePanel: renderTracePanel
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
