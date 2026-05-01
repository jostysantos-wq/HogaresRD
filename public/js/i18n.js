// ══════════════════════════════════════════════════════════════════════════
// HogaresRD — Internationalization (i18n) Module
//
// Usage:
//   HTML: <span data-i18n="hero.title_1">Encuentra tu hogar</span>
//         <input data-i18n-placeholder="hero.search_placeholder_buy" />
//   JS:   i18n.t('nav.buy') → "Buy" or "Comprar"
//         i18n.lang          → "en" or "es"
//         i18n.setLang('en') → switches and re-renders
// ══════════════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  const STORAGE_KEY = 'hogaresrd_lang';
  const DEFAULT_LANG = 'es';
  const SUPPORTED = ['es', 'en'];
  const cache = {};       // { es: {...}, en: {...} }
  let currentLang = DEFAULT_LANG;
  let ready = false;
  const onReadyCallbacks = [];

  // ── Get / set language ────────────────────────────────────────
  function getLang() {
    try { return localStorage.getItem(STORAGE_KEY) || DEFAULT_LANG; } catch { return DEFAULT_LANG; }
  }

  function saveLang(lang) {
    try { localStorage.setItem(STORAGE_KEY, lang); } catch {}
  }

  // ── Load locale JSON ──────────────────────────────────────────
  async function loadLocale(lang) {
    if (cache[lang]) return cache[lang];
    try {
      const res = await fetch(`/locales/${lang}.json`);
      if (!res.ok) throw new Error(res.status);
      cache[lang] = await res.json();
      return cache[lang];
    } catch (err) {
      console.warn(`[i18n] Failed to load locale ${lang}:`, err.message);
      return null;
    }
  }

  // ── Resolve nested key like "hero.title_1" ────────────────────
  function resolve(obj, key) {
    return key.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : null), obj);
  }

  // ── Translate a key ───────────────────────────────────────────
  function t(key, fallback) {
    const locale = cache[currentLang];
    if (!locale) return fallback || key;
    return resolve(locale, key) || fallback || key;
  }

  // ── Apply translations to DOM ─────────────────────────────────
  function applyToDOM() {
    // Text content
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const val = t(key);
      if (val && val !== key) el.textContent = val;
    });

    // innerHTML (for elements with nested HTML like icons + text)
    document.querySelectorAll('[data-i18n-html]').forEach(el => {
      const key = el.getAttribute('data-i18n-html');
      const val = t(key);
      if (val && val !== key) el.innerHTML = val;
    });

    // Placeholders
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      const val = t(key);
      if (val && val !== key) el.placeholder = val;
    });

    // Title attributes
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.getAttribute('data-i18n-title');
      const val = t(key);
      if (val && val !== key) el.title = val;
    });

    // Aria labels
    document.querySelectorAll('[data-i18n-aria]').forEach(el => {
      const key = el.getAttribute('data-i18n-aria');
      const val = t(key);
      if (val && val !== key) el.setAttribute('aria-label', val);
    });

    // Update lang toggle button state
    updateToggleUI();
  }

  // ── Language toggle UI ────────────────────────────────────────
  function updateToggleUI() {
    const toggle = document.getElementById('langToggle');
    if (!toggle) return;
    const esBtn = toggle.querySelector('[data-lang="es"]');
    const enBtn = toggle.querySelector('[data-lang="en"]');
    if (esBtn) esBtn.classList.toggle('active', currentLang === 'es');
    if (enBtn) enBtn.classList.toggle('active', currentLang === 'en');
  }

  // ── Inject language toggle into nav ───────────────────────────
  function injectToggle() {
    const navActions = document.querySelector('.nav-actions') || document.querySelector('#navAuthArea')?.parentElement;
    if (!navActions) return;

    // Don't inject twice
    if (document.getElementById('langToggle')) return;

    const toggle = document.createElement('div');
    toggle.id = 'langToggle';
    toggle.style.cssText = 'display:inline-flex;border:1.5px solid var(--border-strong,#CBD5E1);border-radius:6px;overflow:hidden;font-size:0.78rem;font-weight:700;height:32px;flex-shrink:0;';
    toggle.innerHTML = `
      <button data-lang="es" style="padding:0 0.6rem;border:none;background:none;cursor:pointer;font-family:inherit;font-size:inherit;font-weight:inherit;color:var(--text-muted);transition:all 0.2s;" onclick="i18n.setLang('es')">ES</button>
      <button data-lang="en" style="padding:0 0.6rem;border:none;border-left:1.5px solid var(--border-strong,#CBD5E1);background:none;cursor:pointer;font-family:inherit;font-size:inherit;font-weight:inherit;color:var(--text-muted);transition:all 0.2s;" onclick="i18n.setLang('en')">EN</button>
    `;

    // Style active state
    const style = document.createElement('style');
    style.textContent = '#langToggle button.active{background:var(--accent,#006AFF);color:#fff;} #langToggle button:hover:not(.active){background:var(--bg-secondary,#F4F6F9);}';
    document.head.appendChild(style);

    // Insert before the auth area
    navActions.insertBefore(toggle, navActions.firstChild);
    updateToggleUI();
  }

  // ── Set language ──────────────────────────────────────────────
  async function setLang(lang) {
    if (!SUPPORTED.includes(lang)) return;
    if (lang === currentLang && ready) return;

    currentLang = lang;
    saveLang(lang);

    const locale = await loadLocale(lang);
    if (!locale) return;

    applyToDOM();

    // Dispatch event for page-specific handlers
    window.dispatchEvent(new CustomEvent('langchange', { detail: { lang } }));
  }

  // ── Initialize ────────────────────────────────────────────────
  async function init() {
    currentLang = getLang();

    // Preload current locale only — the in-nav ES/EN toggle was removed
    // (browsers handle translation natively); we no longer need both.
    await loadLocale(currentLang);

    // Apply current language
    applyToDOM();

    ready = true;

    // Fire ready callbacks
    onReadyCallbacks.forEach(fn => fn());
    onReadyCallbacks.length = 0;
  }

  // ── onReady callback ──────────────────────────────────────────
  function onReady(fn) {
    if (ready) fn();
    else onReadyCallbacks.push(fn);
  }

  // Auto-init when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ── Public API ────────────────────────────────────────────────
  window.i18n = {
    t,
    get lang() { return currentLang; },
    setLang,
    applyToDOM,
    onReady,
    resolve,
    injectToggle,
  };
})();
