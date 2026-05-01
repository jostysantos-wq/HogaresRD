/* ═══════════════════════════════════════════════════════════════════
 * topnav.js — Builds the shared editorial pill nav
 *
 * Usage:
 *   <link rel="stylesheet" href="/css/topnav.css">
 *   <div id="topnav-mount"></div>
 *   <script src="/js/topnav.js" defer></script>
 *
 * The script also auto-removes legacy <nav>...</nav> blocks on the
 * page so we don't render two navs side-by-side during the migration.
 *
 * Active link is derived from window.location.pathname.
 * Auth state comes from /api/auth/me (cached for 60s in sessionStorage).
 * ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const LINKS = [
    { href: '/home',                          label: 'Inicio',    match: ['/', '/home'] },
    { href: '/comprar',                       label: 'Comprar',   match: ['/comprar', '/mapa'] },
    { href: '/comprar?type=alquiler',         label: 'Alquilar',  match: ['/alquilar'] },
    { href: '/busquedas-guardadas',           label: 'Favoritos', match: ['/busquedas-guardadas'] },
    { href: '/comprar?type=proyecto',         label: 'Proyectos', match: ['/nuevos-proyectos'] },
    { href: '/blog',                          label: 'Blog',      match: ['/blog', '/post'] },
  ];

  const ICONS = {
    msg:    '<svg viewBox="0 0 24 24"><path d="M20 2H4a2 2 0 00-2 2v18l4-4h14a2 2 0 002-2V4a2 2 0 00-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/></svg>',
    bell:   '<svg viewBox="0 0 24 24"><path d="M12 22a2 2 0 002-2h-4a2 2 0 002 2zm6-6V11a6 6 0 00-5-5.91V4a1 1 0 10-2 0v1.09A6 6 0 006 11v5l-2 2v1h16v-1l-2-2z"/></svg>',
    caret:  '<svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>',
    logo:   '<svg viewBox="120 70 280 290" fill="none">' +
            '<line x1="154" y1="88" x2="154" y2="340" stroke="#fff" stroke-width="22" stroke-linecap="square"/>' +
            '<line x1="358" y1="88" x2="358" y2="340" stroke="#fff" stroke-width="22" stroke-linecap="square"/>' +
            '<line x1="182" y1="238" x2="256" y2="188" stroke="#fff" stroke-width="22" stroke-linecap="square"/>' +
            '<line x1="256" y1="188" x2="330" y2="238" stroke="#fff" stroke-width="22" stroke-linecap="square"/>' +
            '</svg>',
  };

  const PRO_ROLES = ['agency', 'broker', 'inmobiliaria', 'constructora', 'secretary'];

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function activeFor(path) {
    const p = (path || '/').split('?')[0];
    return LINKS.find(l => l.match.some(m => m === p || (m !== '/' && p.startsWith(m + '/'))))
        || LINKS.find(l => l.match.includes(p));
  }

  function buildLinks() {
    const here = activeFor(window.location.pathname);
    return LINKS.map(l => {
      const isActive = here && here.href === l.href;
      return `<a class="nav-link${isActive ? ' active' : ''}" href="${l.href}">${l.label}</a>`;
    }).join('');
  }

  function buildShell() {
    const wrap = document.getElementById('topnav-mount');
    if (!wrap) return null;
    wrap.outerHTML = `
      <nav class="topnav-v2" aria-label="Principal">
        <div class="nav-inner">
          <a class="logo" href="/home" aria-label="HogaresRD">
            <div class="logo-icon">${ICONS.logo}</div>
            <span class="logo-text">Hogares<em>RD</em></span>
          </a>
          <div class="nav-center">
            <div class="nav-links">${buildLinks()}</div>
          </div>
          <div class="nav-actions" id="tnv-actions">
            <!-- lang toggle injected by /js/i18n.js if loaded -->
            <!-- auth UI populated below -->
          </div>
        </div>
      </nav>`;
    return document.querySelector('nav.topnav-v2');
  }

  function renderGuest(actions) {
    actions.insertAdjacentHTML('beforeend',
      '<a href="/submit" class="btn-tn-ghost">Publicar</a>' +
      '<a href="/login" class="btn-tn-dark">Iniciar sesión</a>'
    );
  }

  function renderUser(actions, user) {
    const name = user.name || 'Usuario';
    const email = user.email || '';
    const initials = name.split(' ').map(n => n[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || 'U';
    const isPro = PRO_ROLES.includes(user.role);
    const dashHref = isPro ? '/broker-dashboard.html' : '/my-applications';

    actions.insertAdjacentHTML('beforeend',
      `<a class="nav-icon" href="/mensajes" aria-label="Mensajes">${ICONS.msg}</a>` +
      `<a class="nav-icon" href="/notificaciones" aria-label="Notificaciones">${ICONS.bell}<span class="nav-icon-dot" id="tnv-bell-dot" hidden></span></a>` +
      `<button class="nav-user" type="button" aria-label="Cuenta" id="tnv-user-btn">` +
        `<span class="nav-user-avatar">${escapeHtml(initials)}</span>` +
        `<span class="nav-user-meta">` +
          `<span class="nav-user-name">${escapeHtml(name.split(' ')[0])}</span>` +
          `<span class="nav-user-mail">${escapeHtml(email)}</span>` +
        `</span>` +
        `<svg class="nav-user-caret" viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>` +
      `</button>` +
      `<div class="nav-user-menu" id="tnv-user-menu" role="menu" hidden>` +
        `<a href="${dashHref}" role="menuitem">Mi panel</a>` +
        (isPro ? '<a href="/mis-propiedades" role="menuitem">Mis propiedades</a>' : '<a href="/my-applications" role="menuitem">Mis aplicaciones</a>') +
        `<a href="/busquedas-guardadas" role="menuitem">Favoritos y búsquedas</a>` +
        `<a href="/notificaciones" role="menuitem">Notificaciones</a>` +
        `<hr>` +
        `<button type="button" id="tnv-logout" role="menuitem">Cerrar sesión</button>` +
      `</div>`
    );

    // Toggle dropdown
    const btn  = document.getElementById('tnv-user-btn');
    const menu = document.getElementById('tnv-user-menu');
    if (btn && menu) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.hidden = !menu.hidden;
      });
      document.addEventListener('click', (e) => {
        if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) menu.hidden = true;
      });
    }

    // Logout
    const logout = document.getElementById('tnv-logout');
    if (logout) {
      logout.addEventListener('click', async () => {
        try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch (_) {}
        try { localStorage.removeItem('hogaresrd_user'); } catch (_) {}
        try { sessionStorage.removeItem('tnv_me'); } catch (_) {}
        location.href = '/home';
      });
    }

    // Unread notification dot — best-effort, fail silent
    fetch('/api/notifications/unread-count', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const dot = document.getElementById('tnv-bell-dot');
        if (dot && d && Number(d.count || d.unread || 0) > 0) dot.hidden = false;
      })
      .catch(() => {});
  }

  async function fetchMe() {
    // 60-second sessionStorage cache to avoid /api/auth/me on every page load
    try {
      const cached = sessionStorage.getItem('tnv_me');
      if (cached) {
        const { at, user } = JSON.parse(cached);
        if (Date.now() - at < 60_000) return user;
      }
    } catch (_) {}

    try {
      const r = await fetch('/api/auth/me', { credentials: 'include' });
      if (!r.ok) {
        try { sessionStorage.setItem('tnv_me', JSON.stringify({ at: Date.now(), user: null })); } catch (_) {}
        return null;
      }
      const data = await r.json();
      const user = data?.user || data;
      const ok = user && user.id ? user : null;
      try { sessionStorage.setItem('tnv_me', JSON.stringify({ at: Date.now(), user: ok })); } catch (_) {}
      return ok;
    } catch (_) {
      return null;
    }
  }

  function killLegacyNav() {
    // Remove the page's old <nav>...</nav> if it sits at the top of <body>
    // and isn't the new one we just built. Bottom-of-page mobile nav is left
    // alone (it has the .mobile-bottom-nav class).
    document.querySelectorAll('body > nav').forEach(n => {
      if (n.classList.contains('topnav-v2')) return;
      if (n.classList.contains('mobile-bottom-nav')) return;
      n.remove();
    });
    // Some pages wrap the legacy nav in a <header>
    document.querySelectorAll('body > header').forEach(h => {
      if (h.querySelector('nav.topnav-v2')) return;
      // Only remove if it visually appears to be a nav header (has a <nav> inside)
      if (h.querySelector('nav')) h.remove();
    });
  }

  async function init() {
    const nav = buildShell();
    if (!nav) return;

    killLegacyNav();

    const actions = document.getElementById('tnv-actions');
    const user = await fetchMe();

    if (user) renderUser(actions, user);
    else renderGuest(actions);

    // i18n.js auto-injects #langToggle into .nav-actions on its own init.
    // If i18n.js loaded BEFORE us, re-trigger injection now that the mount
    // exists.
    if (window.i18n && typeof window.i18n.injectToggle === 'function') {
      try { window.i18n.injectToggle(); } catch (_) {}
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
