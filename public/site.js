/* site.js — live branding (site name + tagline) from /api/settings
   + original header theme toggle (light / dark / system).
   Pages ship "HAPPY NODE" as the offline default; when the API
   responds, the real name (editable in the admin panel) is applied. */
(function () {
  async function applyBrand() {
    try {
      const r = await fetch('/api/settings', { headers: { accept: 'application/json' } });
      const s = await r.json();
      if (!s || !s.name) return;
      const name = String(s.name);
      const tag = String(s.tagline || '');

      // <title> — prefix with page label when present (e.g. "Register - HAPPY NODE")
      const pageMeta = document.querySelector('meta[name="page-title"]');
      const pageTitle = pageMeta ? pageMeta.getAttribute('content') : '';
      document.title = (pageTitle ? pageTitle + ' - ' : '') + name;

      const bn = document.getElementById('brandName');
      if (bn) bn.textContent = name;
      const bt = document.getElementById('brandTag');
      if (bt) bt.textContent = tag;
    } catch (_) {
      // keep the static default (HAPPY NODE)
    }
  }

  // ---------- theme toggle (original 3-button group) ----------
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function resolve(t) {
    if (t === 'light' || t === 'dark') return t;
    return (mq && mq.matches) ? 'dark' : 'light';
  }

  function applyTheme() {
    const saved = localStorage.getItem('theme') || 'dark';
    const eff = resolve(saved);
    document.documentElement.classList.toggle('light', eff === 'light');
    document.querySelectorAll('.theme-btn').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-theme') === saved);
    });
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.theme-btn');
    if (!btn) return;
    localStorage.setItem('theme', btn.getAttribute('data-theme'));
    applyTheme();
  });

  if (mq) {
    const on = () => applyTheme();
    if (mq.addEventListener) mq.addEventListener('change', on);
    else if (mq.addListener) mq.addListener(on);
  }

  applyTheme();
  applyBrand();
})();