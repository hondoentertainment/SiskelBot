    const ADMIN_KEY_STORAGE = 'siskelbot_admin_key';
    let adminKey = sessionStorage.getItem(ADMIN_KEY_STORAGE);

    function headers() {
      const h = { 'Content-Type': 'application/json' };
      if (adminKey) h['Authorization'] = 'Bearer ' + adminKey;
      return h;
    }

    async function fetchSummary() {
      const opts = { credentials: 'include', headers: headers() };
      const r = await fetch('/api/admin/summary', opts);
      if (!r.ok) {
        if (r.status === 401) return null;
        throw new Error(await r.text());
      }
      return r.json();
    }

    function showLogin(err) {
      document.getElementById('login-section').style.display = 'block';
      document.getElementById('dashboard').style.display = 'none';
      document.getElementById('loading').style.display = 'none';
      const errEl = document.getElementById('login-error');
      errEl.style.display = err ? 'block' : 'none';
      errEl.textContent = err || '';
    }

    function showDashboard(data) {
      document.getElementById('login-section').style.display = 'none';
      document.getElementById('loading').style.display = 'none';
      document.getElementById('dashboard').style.display = 'block';
      document.getElementById('auth-status').textContent = '✓ Authenticated';

      // Users
      const usersTbody = document.querySelector('#users-table tbody');
      usersTbody.innerHTML = '';
      (data.users || []).forEach(u => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${escapeHtml(u.userId)}</td><td><span class="badge">${escapeHtml(u.source)}</span></td><td>${escapeHtml(u.provider || '-')}</td>`;
        usersTbody.appendChild(tr);
      });

      // Workspaces
      const wsTbody = document.querySelector('#workspaces-table tbody');
      wsTbody.innerHTML = '';
      (data.workspaces || []).forEach(({ userId, workspaceId, workspaceName, quota, tokensUsed, override }) => {
        const tr = document.createElement('tr');
        const quotaStr = quota ? `${quota.used.toLocaleString()} / ${quota.limit.toLocaleString}` : '-';
        const overrideStr = override != null ? override.toLocaleString() : '-';
        tr.innerHTML = `
          <td>${escapeHtml(userId)}</td>
          <td>${escapeHtml(workspaceName || workspaceId)}</td>
          <td>${(tokensUsed || 0).toLocaleString()}</td>
          <td>${quotaStr}</td>
          <td>${overrideStr}</td>
          <td>
            <div class="override-form">
              <input type="number" placeholder="Limit" data-ws="${escapeAttr(workspaceId)}" min="1">
              <button data-ws="${escapeAttr(workspaceId)}" data-action="set">Set</button>
              <button class="danger" data-ws="${escapeAttr(workspaceId)}" data-action="clear">Clear</button>
            </div>
          </td>
        `;
        wsTbody.appendChild(tr);
      });

      // Usage
      const usage = data.usage || {};
      const usageTbody = document.querySelector('#usage-table tbody');
      usageTbody.innerHTML = `
        <tr><td>Total requests</td><td>${(usage.totalRequests || 0).toLocaleString()}</td></tr>
        <tr><td>Total input tokens</td><td>${(usage.totalInputTokens || 0).toLocaleString()}</td></tr>
        <tr><td>Total output tokens</td><td>${(usage.totalOutputTokens || 0).toLocaleString()}</td></tr>
        <tr><td>Total tokens</td><td>${(usage.totalTokens || 0).toLocaleString()}</td></tr>
      `;

      // Quota status
      const quotaStatusEl = document.getElementById('quota-status');
      quotaStatusEl.innerHTML = data.system?.quotaConfigured
        ? `<span class="ok">Quota configured</span>`
        : `<span class="warn">Quota not configured</span>`;

      // System health
      const health = data.system?.health || {};
      const integrations = data.system?.integrations || {};
      const sysEl = document.getElementById('system-health');
      sysEl.innerHTML = `
        <p>Backend: <strong>${escapeHtml(health.backend || '-')}</strong> ${health.reachable ? '<span class="ok">reachable</span>' : '<span class="err">unreachable</span>'}</p>
        <p>Latency: ${health.latencyMs != null ? health.latencyMs + ' ms' : '-'}</p>
        <p>Integrations: GitHub ${integrations.github ? '✓' : '-'}, Vercel ${integrations.vercel ? '✓' : '-'}</p>
        <p>Scheduler: ${data.system?.scheduleEnabled ? '<span class="ok">enabled</span>' : 'disabled'}</p>
      `;

      // Audit
      const auditTbody = document.querySelector('#audit-table tbody');
      auditTbody.innerHTML = '';
      (data.auditLog || []).slice(0, 20).forEach(e => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${escapeHtml((e.timestamp || '').slice(0, 19))}</td>
          <td>${escapeHtml(e.action || '-')}</td>
          <td>${e.ok ? '<span class="ok">✓</span>' : '<span class="err">✗</span>'}</td>
          <td>${escapeHtml(e.error || '-')}</td>
        `;
        auditTbody.appendChild(tr);
      });

      // API Keys (Phase 30)
      const keysTbody = document.querySelector('#keys-table tbody');
      keysTbody.innerHTML = '';
      (data.apiKeys || []).forEach(k => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><code>${escapeHtml(k.masked || '****')}</code></td>
          <td>${escapeHtml(k.userId)}</td>
          <td>${(k.scopes || []).join(', ') || '-'}</td>
          <td>${escapeHtml((k.createdAt || '').slice(0, 10))}</td>
          <td><button class="danger revoke-key-btn" data-id="${escapeAttr(k.id)}">Revoke</button></td>
        `;
        keysTbody.appendChild(tr);
      });
      document.querySelectorAll('.revoke-key-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Revoke this key? It will stop working immediately.')) return;
          const r = await fetch('/api/admin/keys/' + encodeURIComponent(btn.dataset.id), { method: 'DELETE', credentials: 'include', headers: headers() });
          if (!r.ok) alert('Failed to revoke: ' + (await r.text()));
          else load();
        });
      });

      // Override button handlers
      document.querySelectorAll('.override-form button[data-action="set"]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const ws = btn.dataset.ws;
          const input = btn.parentElement.querySelector('input[type="number"]');
          const limit = parseInt(input.value, 10);
          if (!limit || limit <= 0) return;
          await setOverride(ws, limit);
          load();
        });
      });
      document.querySelectorAll('.override-form button[data-action="clear"]').forEach(btn => {
        btn.addEventListener('click', async () => {
          await setOverride(btn.dataset.ws, null);
          load();
        });
      });
    }

    async function setOverride(workspace, limit) {
      const opts = {
        method: 'POST',
        credentials: 'include',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace, limit })
      };
      const r = await fetch('/api/admin/quotas/override', opts);
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    }

    function escapeHtml(s) {
      if (s == null) return '';
      const d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }
    function escapeAttr(s) {
      return escapeHtml(s).replace(/"/g, '&quot;');
    }

    async function load() {
      document.getElementById('loading').style.display = 'block';
      try {
        const data = await fetchSummary();
        if (!data) {
          adminKey = null;
          sessionStorage.removeItem(ADMIN_KEY_STORAGE);
          showLogin('Authentication required. Sign in or enter ADMIN_API_KEY.');
          return;
        }
        showDashboard(data);
      } catch (e) {
        showLogin(e.message || 'Failed to load');
      } finally {
        document.getElementById('loading').style.display = 'none';
      }
    }

    document.getElementById('unlock-btn').addEventListener('click', () => {
      adminKey = document.getElementById('admin-key').value.trim();
      if (!adminKey) return;
      sessionStorage.setItem(ADMIN_KEY_STORAGE, adminKey);
      load();
    });

    document.getElementById('add-key-btn').addEventListener('click', async () => {
      const userIdEl = document.getElementById('key-user-id');
      const scopesEl = document.getElementById('key-scopes');
      const msgEl = document.getElementById('key-add-msg');
      const userId = (userIdEl?.value || '').trim();
      if (!userId) {
        msgEl.style.display = 'block';
        msgEl.textContent = 'User ID required';
        return;
      }
      msgEl.style.display = 'none';
      const scopesRaw = (scopesEl?.value || 'read,write').trim();
      const scopes = scopesRaw ? scopesRaw.split(',').map(s => s.trim()).filter(Boolean) : ['read', 'write'];
      try {
        const r = await fetch('/api/admin/keys', {
          method: 'POST',
          credentials: 'include',
          headers: { ...headers(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, scopes })
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          msgEl.style.display = 'block';
          msgEl.textContent = data.error || 'Failed to add key';
          return;
        }
        msgEl.style.display = 'block';
        msgEl.textContent = 'Key created. Save it now - it won\'t be shown again: ' + (data.key || '');
        msgEl.style.color = '#34d399';
        load();
      } catch (e) {
        msgEl.style.display = 'block';
        msgEl.textContent = e.message || 'Failed';
      }
    });

    load();
