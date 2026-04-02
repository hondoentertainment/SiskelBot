    let allPacks = [];
    let installedIds = new Set();

    function getWorkspace() {
      return (document.getElementById('workspace-input').value || '').trim() || 'default';
    }

    function escapeHtml(s) {
      if (s == null) return '';
      const d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    async function fetchPacks() {
      const r = await fetch('/api/marketplace');
      if (!r.ok) throw new Error('Failed to load packs');
      const data = await r.json();
      return data.packs || [];
    }

    async function fetchInstalled(workspaceId) {
      try {
        const r = await fetch('/api/workspaces/' + encodeURIComponent(workspaceId) + '/plugins');
        if (!r.ok) return [];
        const data = await r.json();
        return (data.packs || []).map(p => p.id);
      } catch {
        return [];
      }
    }

    async function installPack(packId) {
      const workspaceId = getWorkspace();
      const r = await fetch('/api/marketplace/' + encodeURIComponent(packId) + '/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ workspaceId })
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.error || 'Install failed');
      }
      return r.json();
    }

    async function uninstallPack(packId) {
      const workspaceId = getWorkspace();
      const r = await fetch('/api/marketplace/' + encodeURIComponent(packId) + '/install?workspaceId=' + encodeURIComponent(workspaceId), {
        method: 'DELETE',
        credentials: 'include'
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.error || 'Uninstall failed');
      }
      return r.json();
    }

    function renderPacks(packs) {
      const grid = document.getElementById('pack-grid');
      const empty = document.getElementById('empty-state');
      grid.innerHTML = '';

      if (packs.length === 0) {
        empty.style.display = 'block';
        return;
      }
      empty.style.display = 'none';

      for (const pack of packs) {
        const isInstalled = installedIds.has(pack.id);
        const card = document.createElement('div');
        card.className = 'pack-card';
        card.innerHTML = `
          <div class="pack-header">
            <h3 class="pack-name">${escapeHtml(pack.name)}</h3>
            <span class="pack-version">v${escapeHtml(pack.version)}</span>
          </div>
          <p class="pack-description">${escapeHtml(pack.description)}</p>
          <div class="pack-meta">
            <span>By ${escapeHtml(pack.author)}</span>
            <span class="badge">${escapeHtml(pack.category)}</span>
            <span>${pack.actionCount} action${pack.actionCount !== 1 ? 's' : ''}</span>
            ${isInstalled ? '<span class="badge badge-installed">Installed</span>' : ''}
          </div>
          <div class="pack-actions">
            ${isInstalled
              ? `<button class="btn btn-uninstall" data-pack="${escapeHtml(pack.id)}" data-action="uninstall">Uninstall</button>`
              : `<button class="btn btn-install" data-pack="${escapeHtml(pack.id)}" data-action="install">Install</button>`
            }
            <button class="btn btn-details" data-pack="${escapeHtml(pack.id)}" data-action="details">Details</button>
          </div>
        `;
        grid.appendChild(card);
      }

      // Bind button handlers
      grid.querySelectorAll('button[data-action="install"]').forEach(btn => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          btn.textContent = 'Installing...';
          try {
            await installPack(btn.dataset.pack);
            await load();
          } catch (e) {
            showError(e.message);
            btn.disabled = false;
            btn.textContent = 'Install';
          }
        });
      });

      grid.querySelectorAll('button[data-action="uninstall"]').forEach(btn => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          btn.textContent = 'Removing...';
          try {
            await uninstallPack(btn.dataset.pack);
            await load();
          } catch (e) {
            showError(e.message);
            btn.disabled = false;
            btn.textContent = 'Uninstall';
          }
        });
      });

      grid.querySelectorAll('button[data-action="details"]').forEach(btn => {
        btn.addEventListener('click', () => showDetails(btn.dataset.pack));
      });
    }

    async function showDetails(packId) {
      try {
        const r = await fetch('/api/marketplace/' + encodeURIComponent(packId));
        if (!r.ok) throw new Error('Not found');
        const pack = await r.json();
        document.getElementById('modal-name').textContent = pack.name;
        document.getElementById('modal-version').textContent = 'Version: ' + pack.version;
        document.getElementById('modal-author').textContent = 'Author: ' + pack.author;
        document.getElementById('modal-description').textContent = pack.description;
        document.getElementById('modal-category').textContent = 'Category: ' + (pack.category || 'uncategorized');
        const list = document.getElementById('modal-actions');
        list.innerHTML = '';
        (pack.actions || []).forEach(a => {
          const li = document.createElement('li');
          li.textContent = a.name + ' (' + a.type + ')';
          list.appendChild(li);
        });
        document.getElementById('detail-modal').classList.add('open');
      } catch (e) {
        showError(e.message);
      }
    }

    document.getElementById('modal-close-btn').addEventListener('click', () => {
      document.getElementById('detail-modal').classList.remove('open');
    });
    document.getElementById('detail-modal').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        e.currentTarget.classList.remove('open');
      }
    });

    function showError(msg) {
      const el = document.getElementById('error-msg');
      el.textContent = msg;
      el.style.display = 'block';
      setTimeout(() => { el.style.display = 'none'; }, 5000);
    }

    function populateCategories(packs) {
      const select = document.getElementById('category-filter');
      const cats = [...new Set(packs.map(p => p.category).filter(Boolean))].sort();
      // Keep "All" option, remove old dynamic options
      while (select.options.length > 1) select.remove(1);
      for (const cat of cats) {
        const opt = document.createElement('option');
        opt.value = cat;
        opt.textContent = cat.charAt(0).toUpperCase() + cat.slice(1);
        select.appendChild(opt);
      }
    }

    async function load() {
      const errEl = document.getElementById('error-msg');
      errEl.style.display = 'none';
      try {
        const workspaceId = getWorkspace();
        const [packs, installed] = await Promise.all([
          fetchPacks(),
          fetchInstalled(workspaceId)
        ]);
        allPacks = packs;
        installedIds = new Set(installed);
        populateCategories(packs);
        applyFilter();
      } catch (e) {
        showError(e.message);
      }
    }

    function applyFilter() {
      const cat = document.getElementById('category-filter').value;
      const filtered = cat ? allPacks.filter(p => p.category === cat) : allPacks;
      renderPacks(filtered);
    }

    document.getElementById('category-filter').addEventListener('change', applyFilter);
    document.getElementById('workspace-input').addEventListener('change', load);

    load();
