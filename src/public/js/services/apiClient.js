import { getActiveTab } from '../components/navigation/tabsAndRouter.js';
import { $ } from '../utils/dom.js';
import { updateErrorBadge } from '../components/operations/processAndErrorCenter.js';

const localClientErrors = [];

function reportClientError(op, message, target = '', stack = '') {
  if (!message) return;
  const activeTab = typeof getActiveTab === 'function' ? getActiveTab() : null;
  const meta = {
    tabPath: activeTab ? activeTab.path : '',
    viewType: activeTab ? activeTab.viewType : '',
    ua: navigator.userAgent,
  };
  const localItem = {
    id: `local-${Date.now().toString(36)}`,
    time: new Date().toISOString(),
    op: op || 'Arayüz',
    target: target || meta.tabPath || '',
    message: String(message),
    stack: stack ? String(stack).slice(0, 4000) : '',
    meta,
  };
  localClientErrors.unshift(localItem);
  if (localClientErrors.length > 50) localClientErrors.length = 50;

  fetch('/api/errors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'report',
      op: localItem.op,
      target: localItem.target,
      message: localItem.message,
      stack: localItem.stack,
      meta,
    }),
  })
    .then((r) => r.json())
    .then((d) => {
      if (d && d.total !== undefined) updateErrorBadge({ total: d.total, unread: d.unread });
    })
    .catch(() => {
      updateErrorBadge({ total: localClientErrors.length, unread: localClientErrors.length });
    });
}

async function api(url, opts = {}) {
  const method = String(opts.method || 'GET').toUpperCase();
  const maxAttempts = method === 'GET' && !opts.noRetry ? 2 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const fetchOpts = {
        headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
        ...opts,
      };
      if (!fetchOpts.signal && opts.timeoutMs > 0 && typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
        fetchOpts.signal = AbortSignal.timeout(opts.timeoutMs);
      }
      const res = await fetch(url, fetchOpts);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data.error || `HTTP ${res.status}`;
        if (res.status !== 500 && !opts.silentErrors && !String(url).startsWith('/api/errors')) {
          reportClientError(url, msg);
        }
        throw new Error(msg);
      }
      return data;
    } catch (err) {
      const isNetworkErr = err && (String(err.message || '').includes('Failed to fetch') || err.name === 'TimeoutError');
      if (isNetworkErr && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      if (err && err.name !== 'AbortError' && !opts.silentErrors && !String(url).startsWith('/api/errors') && !err.loggedClient) {
        if (isNetworkErr) {
          reportClientError(url, err.message);
        }
      }
      throw err;
    }
  }
}


export {
  api,
  localClientErrors,
  reportClientError,
};
