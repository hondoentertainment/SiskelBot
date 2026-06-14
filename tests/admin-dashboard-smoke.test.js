import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const HTML_PATH = path.resolve(process.cwd(), 'client/admin-dashboard.html');

function read() {
  return fs.readFileSync(HTML_PATH, 'utf8');
}

test('admin-dashboard.html exists and looks like HTML', () => {
  const html = read();
  assert.ok(html.includes('<!DOCTYPE'), 'missing doctype');
  assert.ok(html.includes('<html'), 'missing <html>');
  assert.ok(html.includes('</html>'), 'missing </html>');
  assert.ok(html.includes('<script'), 'missing <script>');
  assert.ok(html.includes('</script>'), 'missing </script>');
  assert.ok(html.includes('<style'), 'missing <style>');
  assert.ok(html.includes('</style>'), 'missing </style>');
});

test('admin-dashboard.html wires the 7 admin endpoint paths', () => {
  const html = read();
  const endpoints = [
    '/api/admin/agent-stats/failures',
    '/api/admin/agent-stats/reliability',
    '/api/admin/agent-stats/swarm-conflicts',
    '/api/admin/prompt-patches',
    '/api/admin/traces',
    '/api/v1/admin/agent-feedback/aggregate',
    '/api/admin/eval-history/latest'
  ];
  for (const ep of endpoints) {
    assert.ok(html.includes(ep), 'missing endpoint: ' + ep);
  }
});

test('admin-dashboard.html has fallback for v1 feedback 404', () => {
  const html = read();
  assert.ok(html.includes('/api/admin/agent-feedback/aggregate'), 'missing v1 feedback fallback');
});

test('admin-dashboard.html defines escapeHtml helper', () => {
  const html = read();
  assert.ok(/function\s+escapeHtml\s*\(/.test(html), 'escapeHtml helper not defined');
});

test('admin-dashboard.html references sessionStorage', () => {
  const html = read();
  assert.ok(html.includes('sessionStorage'), 'sessionStorage not referenced');
});

test('admin-dashboard.html uses Authorization Bearer header', () => {
  const html = read();
  assert.ok(/Authorization/.test(html), 'Authorization header not set');
  assert.ok(/Bearer/.test(html), 'Bearer scheme not used');
});

test('admin-dashboard.html file size is between 5KB and 80KB', () => {
  const stat = fs.statSync(HTML_PATH);
  assert.ok(stat.size >= 5 * 1024, 'file too small: ' + stat.size);
  assert.ok(stat.size <= 80 * 1024, 'file too large: ' + stat.size);
});

test('admin-dashboard.html contains all 6 summary card labels', () => {
  const html = read().toLowerCase();
  const labels = ['feedback', 'reliable', 'chronic', 'conflict', 'patch', 'trace'];
  for (const l of labels) {
    assert.ok(html.includes(l), 'missing card label substring: ' + l);
  }
});
