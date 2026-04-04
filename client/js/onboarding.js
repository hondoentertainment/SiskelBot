/**
 * Onboarding flow module for SiskelBot.
 * Multi-step wizard for first-time users.
 */

const STORAGE_KEY = 'siskelbot_onboarding_complete';

const STEPS = [
  {
    id: 'welcome',
    title: 'Welcome to SiskelBot',
    body: `
      <p>SiskelBot is your streaming AI assistant proxy. It connects to Ollama, vLLM, or OpenAI backends and gives you a clean chat interface with workspaces, context management, and more.</p>
      <p>Let's take a quick tour to get you started.</p>
    `
  },
  {
    id: 'backend',
    title: 'Your Backend',
    body: `
      <p>SiskelBot proxies requests to an AI backend. Your current configuration will be shown below.</p>
      <div id="onboarding-backend-info" class="onboarding-info-box">Loading configuration...</div>
      <p>You can change the backend anytime via environment variables (<code>BACKEND</code>, <code>OLLAMA_URL</code>, <code>VLLM_URL</code>).</p>
    `,
    onEnter(el) {
      const box = el.querySelector('#onboarding-backend-info');
      fetch('/config')
        .then((r) => r.json())
        .then((cfg) => {
          const backend = cfg.backend || 'unknown';
          const model = cfg.defaultModel || 'default';
          box.textContent = `Backend: ${backend} | Model: ${model}`;
        })
        .catch(() => {
          box.textContent = 'Could not load config. The server may be starting up.';
        });
    }
  },
  {
    id: 'tryit',
    title: 'Try It Out',
    body: `
      <p>When you close this wizard, try sending a message. Here is a good starter prompt:</p>
      <div class="onboarding-info-box"><em>"Hello! What can you do?"</em></div>
      <p>SiskelBot streams responses in real time so you will see tokens appear as they are generated.</p>
    `
  },
  {
    id: 'knowledge',
    title: 'Knowledge Base',
    body: `
      <p>You can add context documents to help the AI give better answers. Use the Knowledge Base to upload notes, docs, or code snippets that get included as context in your conversations.</p>
      <p>Access it from the sidebar or via the <code>/api/v1/knowledge</code> endpoint.</p>
    `
  },
  {
    id: 'done',
    title: 'You are all set!',
    body: `
      <p>That covers the basics. Here are some resources:</p>
      <ul>
        <li>Press <kbd>Ctrl+/</kbd> (or <kbd>\u2318/</kbd> on Mac) to view keyboard shortcuts</li>
        <li>Check <code>docs/</code> in the repo for detailed guides</li>
        <li>Use workspaces to organize different projects</li>
      </ul>
      <p>Enjoy using SiskelBot!</p>
    `
  }
];

export function shouldShowOnboarding() {
  return localStorage.getItem(STORAGE_KEY) !== '1';
}

export function markOnboardingComplete() {
  localStorage.setItem(STORAGE_KEY, '1');
}

export function renderOnboarding(containerEl, callbacks = {}) {
  const { onComplete, onSkip } = callbacks;
  let currentStep = 0;

  const overlay = document.createElement('div');
  overlay.className = 'onboarding-overlay';

  const style = document.createElement('style');
  style.textContent = `
    .onboarding-overlay { position: fixed; inset: 0; z-index: 10000; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.6); }
    .onboarding-card { background: var(--bg-secondary, #1e293b); color: var(--text-primary, #e2e8f0); border-radius: 16px; padding: 32px; max-width: 520px; width: 90%; box-shadow: 0 24px 80px rgba(0,0,0,0.4); position: relative; }
    .onboarding-card h2 { margin: 0 0 16px; font-size: 22px; }
    .onboarding-card p { margin: 8px 0; line-height: 1.6; font-size: 15px; color: var(--text-secondary, #94a3b8); }
    .onboarding-card ul { margin: 8px 0; padding-left: 20px; color: var(--text-secondary, #94a3b8); font-size: 15px; line-height: 1.8; }
    .onboarding-card kbd { background: var(--bg-tertiary, #334155); border: 1px solid var(--border, #334155); border-radius: 4px; padding: 1px 6px; font-size: 13px; }
    .onboarding-card code { background: var(--bg-tertiary, #334155); border-radius: 4px; padding: 1px 6px; font-size: 13px; }
    .onboarding-info-box { background: var(--bg-tertiary, #334155); border-radius: 8px; padding: 12px 16px; margin: 12px 0; font-size: 14px; color: var(--text-primary, #e2e8f0); }
    .onboarding-footer { display: flex; justify-content: space-between; align-items: center; margin-top: 24px; }
    .onboarding-dots { display: flex; gap: 6px; }
    .onboarding-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--bg-tertiary, #334155); transition: background 0.2s; }
    .onboarding-dot.active { background: var(--accent, #2563eb); }
    .onboarding-actions { display: flex; gap: 8px; }
    .onboarding-btn { border: none; border-radius: 8px; padding: 8px 20px; font-size: 14px; cursor: pointer; transition: background 0.15s; }
    .onboarding-btn-skip { background: transparent; color: var(--text-muted, #64748b); }
    .onboarding-btn-skip:hover { color: var(--text-secondary, #94a3b8); }
    .onboarding-btn-next { background: var(--accent, #2563eb); color: #fff; }
    .onboarding-btn-next:hover { background: var(--accent-hover, #1d4ed8); }
  `;
  overlay.appendChild(style);

  const card = document.createElement('div');
  card.className = 'onboarding-card';
  overlay.appendChild(card);

  function render() {
    const step = STEPS[currentStep];
    const isLast = currentStep === STEPS.length - 1;
    const isFirst = currentStep === 0;

    card.innerHTML = `
      <h2>${step.title}</h2>
      <div class="onboarding-body">${step.body}</div>
      <div class="onboarding-footer">
        <div class="onboarding-dots">
          ${STEPS.map((_, i) => `<div class="onboarding-dot${i === currentStep ? ' active' : ''}"></div>`).join('')}
        </div>
        <div class="onboarding-actions">
          ${!isLast ? '<button class="onboarding-btn onboarding-btn-skip">Skip</button>' : ''}
          ${!isFirst && !isLast ? '<button class="onboarding-btn onboarding-btn-back">Back</button>' : ''}
          <button class="onboarding-btn onboarding-btn-next">${isLast ? 'Get Started' : 'Next'}</button>
        </div>
      </div>
    `;

    // Wire up buttons
    const skipBtn = card.querySelector('.onboarding-btn-skip');
    const backBtn = card.querySelector('.onboarding-btn-back');
    const nextBtn = card.querySelector('.onboarding-btn-next');

    if (skipBtn) {
      skipBtn.addEventListener('click', () => {
        markOnboardingComplete();
        overlay.remove();
        if (onSkip) onSkip();
      });
    }

    if (backBtn) {
      backBtn.addEventListener('click', () => {
        currentStep--;
        render();
      });
    }

    nextBtn.addEventListener('click', () => {
      if (isLast) {
        markOnboardingComplete();
        overlay.remove();
        if (onComplete) onComplete();
      } else {
        currentStep++;
        render();
      }
    });

    // Run step-specific hooks
    if (step.onEnter) {
      step.onEnter(card);
    }
  }

  render();
  containerEl.appendChild(overlay);
  return overlay;
}

// Expose on window for non-module consumers
if (typeof window !== 'undefined') {
  window.SiskelOnboarding = { shouldShowOnboarding, renderOnboarding, markOnboardingComplete };
}
