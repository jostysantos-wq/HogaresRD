/**
 * nav-auth.js — Shared nav authentication renderer
 *
 * Drop this script at the end of <body> on any page that has:
 *   <div id="navAuthArea"></div>   ← starts empty, this fills it
 *
 * Flow:
 *  1. Reads hogaresrd_user from localStorage  → instant render (no flash)
 *  2. If no cached user but session cookie may exist, hits /api/auth/me
 *  3. Caches result to localStorage for subsequent pages
 *
 * Dropdown is role-aware:
 *  - broker / agency / inmobiliaria / secretary → "Panel Profesional" menu
 *  - regular users → personal account menu
 */
(function () {
  'use strict';

  const area = document.getElementById('navAuthArea');
  if (!area) return;

  const PRO_ROLES = ['agency', 'broker', 'inmobiliaria', 'secretary'];

  /* ── helpers ───────────────────────────────────────────────── */
  function getStoredUser() {
    try {
      const raw = localStorage.getItem('hogaresrd_user');
      if (!raw) return null;
      const u = JSON.parse(raw);
      return (u && u.name) ? u : null;
    } catch { return null; }
  }

  /* ── logged-out state ──────────────────────────────────────── */
  function renderLoggedOut() {
    area.innerHTML = '<a href="/login" class="btn-login">Iniciar sesi\u00f3n</a>';
  }

  /* ── logged-in state ───────────────────────────────────────── */
  function renderLoggedIn(user) {
    const initials   = (user.name || 'U').split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
    const firstName  = (user.name || 'Usuario').split(' ')[0];
    const isPro      = PRO_ROLES.includes(user.role);
    const isInm      = user.role === 'inmobiliaria';

    /* ── SVG icon helper ── */
    const _i = (d) => `<svg class="_nav-svg" viewBox="0 0 24 24"><path d="${d}"/></svg>`;
    const IC = {
      dashboard:  _i('M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z'),
      messages:   _i('M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z'),
      calendar:   _i('M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zm0-12H5V6h14v2zm-7 5h5v5h-5v-5z'),
      clock:      _i('M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z'),
      ai:         _i('M12 2l2.09 6.26L21 9.27l-5.47 3.97 2.09 6.43L12 15.69l-5.62 3.98 2.09-6.43L3 9.27l6.91-1.01L12 2z'),
      team:       _i('M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z'),
      clipboard:  _i('M19 3h-4.18C14.4 1.84 13.3 1 12 1s-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm7 16H5V5h2v3h10V5h2v14z'),
      chart:      _i('M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z'),
      person:     _i('M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'),
      card:       _i('M20 4H4c-1.11 0-1.99.89-1.99 2L2 18c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V6c0-1.11-.89-2-2-2zm0 14H4v-6h16v6zm0-10H4V6h16v2z'),
      lock:       _i('M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zM15.1 8H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z'),
      shield:     _i('M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z'),
      heart:      _i('M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z'),
      bell:       _i('M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z'),
      logout:     _i('M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z'),
    };

    /* ── build dropdown HTML based on role ── */
    const proMenu = `
      <div class="_nav-section-lbl">Panel Profesional</div>
      <a href="/broker" class="_nav-dd">
        <span class="_nav-dd-left">${IC.dashboard} Dashboard</span>
      </a>
      <a href="/broker#mensajes" class="_nav-dd">
        <span class="_nav-dd-left">${IC.messages} Mensajes</span>
      </a>
      <a href="/broker#tour-requests" class="_nav-dd">
        <span class="_nav-dd-left">${IC.calendar} Solicitudes de Tour</span>
      </a>
      <a href="/broker#availability" class="_nav-dd">
        <span class="_nav-dd-left">${IC.clock} Disponibilidad</span>
      </a>
      <a href="/broker#chat-ia" class="_nav-dd">
        <span class="_nav-dd-left">${IC.ai} Chat IA</span>
      </a>
      ${isInm ? `
      <hr class="_nav-hr">
      <div class="_nav-section-lbl">Equipo</div>
      <a href="/broker#team-members" class="_nav-dd">
        <span class="_nav-dd-left">${IC.team} Miembros</span>
      </a>
      <a href="/broker#team-requests" class="_nav-dd">
        <span class="_nav-dd-left">${IC.clipboard} Solicitudes</span>
      </a>
      <a href="/broker#team-performance" class="_nav-dd">
        <span class="_nav-dd-left">${IC.chart} Rendimiento</span>
      </a>
      ` : ''}
      <hr class="_nav-hr">
      <div class="_nav-section-lbl">Cuenta</div>
      <a href="/subscription" class="_nav-dd">
        <span class="_nav-dd-left">${IC.card} Suscripci\u00f3n</span>
      </a>
      <a href="/broker#contrasena" class="_nav-dd">
        <span class="_nav-dd-left">${IC.lock} Contrase\u00f1a y 2FA</span>
      </a>`;

    const userMenu = `
      <div class="_nav-section-lbl">Mi Cuenta</div>
      <a href="/profile" class="_nav-dd">
        <span class="_nav-dd-left">${IC.person} Mi Perfil</span>
      </a>
      <a href="/favorites" class="_nav-dd">
        <span class="_nav-dd-left">${IC.heart} Mis Favoritos</span>
      </a>
      <a href="/my-applications" class="_nav-dd">
        <span class="_nav-dd-left">${IC.clipboard} Mis Aplicaciones</span>
      </a>
      <a href="/busquedas-guardadas" class="_nav-dd">
        <span class="_nav-dd-left">${IC.bell} B\u00fasquedas Guardadas</span>
      </a>
      <a href="/mensajes" class="_nav-dd">
        <span class="_nav-dd-left">${IC.messages} Mensajes</span>
      </a>`;

    area.innerHTML = `
      ${isPro ? `
      <a href="/submit" style="background:var(--accent);color:#fff;font-size:0.9rem;font-weight:600;padding:0.5rem 1.2rem;border-radius:8px;text-decoration:none;white-space:nowrap;display:inline-flex;align-items:center;gap:0.4rem;">
        <svg viewBox="0 0 24 24" style="width:15px;height:15px;fill:#fff;flex-shrink:0;"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
        Publicar
      </a>` : ''}
      <div style="position:relative;" id="navUserMenu">
        <button id="navAvatarBtn" style="display:flex;align-items:center;gap:0.5rem;background:none;border:1.5px solid var(--border);border-radius:50px;padding:0.3rem 0.75rem 0.3rem 0.3rem;cursor:pointer;color:var(--text);transition:border-color 0.2s,background 0.2s;">
          <div style="width:28px;height:28px;border-radius:50%;background:var(--accent);color:#fff;font-size:0.72rem;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0;letter-spacing:0;">${initials}</div>
          <span style="font-size:0.88rem;font-weight:600;max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${firstName}</span>
          <svg viewBox="0 0 24 24" style="width:15px;height:15px;fill:currentColor;opacity:0.45;flex-shrink:0;"><path d="M7 10l5 5 5-5z"/></svg>
        </button>
        <div id="navUserDd" style="display:none;position:absolute;top:calc(100% + 8px);right:0;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;box-shadow:0 8px 40px rgba(17,17,16,0.14);min-width:${isPro ? '230px' : '210px'};overflow:hidden;z-index:300;">
          ${isPro ? proMenu : userMenu}
          <hr class="_nav-hr">
          <div class="_nav-dd _nav-dd-theme" id="navThemeToggle" onclick="event.stopPropagation();if(window.toggleTheme)window.toggleTheme();_navSyncTheme();">
            <span class="_nav-dd-left"><span id="navThemeIcSvg"></span><span id="navThemeLbl"></span></span>
            <div style="width:36px;height:20px;border-radius:50px;background:var(--toggle-bg,#CBD5E1);position:relative;flex-shrink:0;">
              <div id="navThemeKnob" style="width:16px;height:16px;border-radius:50%;background:var(--toggle-knob,#fff);position:absolute;top:2px;transition:left 0.3s;box-shadow:0 1px 3px rgba(0,0,0,0.2);"></div>
            </div>
          </div>
          <hr class="_nav-hr">
          <button class="_nav-dd" style="color:#CF142B;background:none;border:none;cursor:pointer;text-align:left;width:100%;font-family:inherit;font-size:0.875rem;" onclick="navAuthLogout()">
            <span class="_nav-dd-left">${IC.logout} Cerrar Sesi\u00f3n</span>
          </button>
        </div>
      </div>`;

    /* ── inject styles (once) ─── */
    if (!document.getElementById('_navAuthStyle')) {
      const s = document.createElement('style');
      s.id = '_navAuthStyle';
      s.textContent = `
        ._nav-dd {
          display: flex; align-items: center; justify-content: space-between;
          padding: 0.6rem 1.1rem; font-size: 0.875rem; color: var(--text);
          text-decoration: none; transition: background 0.15s; gap: 0.5rem;
          cursor: pointer;
        }
        ._nav-dd:hover { background: var(--accent-light); color: var(--accent); }
        ._nav-dd-left { display: flex; align-items: center; gap: 0.6rem; }
        ._nav-svg { width: 16px; height: 16px; fill: var(--text-muted); flex-shrink: 0; }
        ._nav-dd:hover ._nav-svg { fill: var(--accent); }
        button._nav-dd:hover ._nav-svg { fill: #CF142B; }
        ._nav-section-lbl {
          padding: 0.55rem 1.1rem 0.2rem;
          font-size: 0.7rem; font-weight: 700; text-transform: uppercase;
          letter-spacing: 0.07em; color: var(--text-muted); opacity: 0.7;
        }
        ._nav-hr { border: none; border-top: 1px solid var(--border); margin: 0.25rem 0; }
        ._nav-dd-theme { cursor: pointer; }
      `;
      document.head.appendChild(s);
    }

    /* ── sync theme indicator ─── */
    function _navSyncTheme() {
      const dark = document.documentElement.getAttribute('data-theme') === 'dark';
      const lbl  = document.getElementById('navThemeLbl');
      const icEl = document.getElementById('navThemeIcSvg');
      const knob = document.getElementById('navThemeKnob');
      if (lbl)  lbl.textContent = dark ? 'Modo Claro' : 'Modo Oscuro';
      if (icEl) icEl.innerHTML  = dark
        ? '<svg class="_nav-svg" viewBox="0 0 24 24"><path d="M6.76 4.84l-1.8-1.79-1.41 1.41 1.79 1.8 1.42-1.42zM4 10.5H1v2h3v-2zm9-9.95h-2V3.5h2V.55zm7.45 3.91l-1.41-1.41-1.79 1.79 1.41 1.41 1.79-1.79zm-3.21 13.7l1.79 1.8 1.41-1.41-1.8-1.79-1.4 1.4zM20 10.5v2h3v-2h-3zm-8-5c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm-1 16.95h2V19.5h-2v2.95zm-7.45-3.91l1.41 1.41 1.79-1.8-1.41-1.41-1.79 1.8z"/></svg>'
        : '<svg class="_nav-svg" viewBox="0 0 24 24"><path d="M9 2c-1.05 0-2.05.16-3 .46 4.06 1.27 7 5.06 7 9.54 0 4.48-2.94 8.27-7 9.54.95.3 1.95.46 3 .46 5.52 0 10-4.48 10-10S14.52 2 9 2z"/></svg>';
      if (knob) knob.style.left = dark ? '18px' : '2px';
    }
    window._navSyncTheme = _navSyncTheme;
    _navSyncTheme();

    /* ── avatar button toggle ─── */
    document.getElementById('navAvatarBtn').addEventListener('click', e => {
      e.stopPropagation();
      const dd = document.getElementById('navUserDd');
      const isOpen = dd.style.display !== 'none';
      if (!isOpen) _navSyncTheme();
      dd.style.display = isOpen ? 'none' : 'block';
    });

    /* ── hover effect on avatar btn ─── */
    const btn = document.getElementById('navAvatarBtn');
    btn.addEventListener('mouseenter', () => {
      btn.style.borderColor = 'var(--accent)';
      btn.style.background  = 'var(--accent-light)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.borderColor = 'var(--border)';
      btn.style.background  = 'none';
    });
  }

  /* ── close dropdown on outside click ─── */
  document.addEventListener('click', () => {
    const dd = document.getElementById('navUserDd');
    if (dd) dd.style.display = 'none';
  });

  /* ── logout ─────────────────────────────────────────────────── */
  window.navAuthLogout = async function () {
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch {}
    ['hogaresrd_token', 'hogaresrd_user', 'token'].forEach(k => localStorage.removeItem(k));
    window.location.href = '/home';
  };

  /* ── render ──────────────────────────────────────────────────── */
  const user = getStoredUser();

  if (user) {
    renderLoggedIn(user);
  } else {
    fetch('/api/auth/me', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(u => {
        if (u && u.name) {
          try { localStorage.setItem('hogaresrd_user', JSON.stringify(u)); } catch {}
          renderLoggedIn(u);
        } else {
          renderLoggedOut();
        }
      })
      .catch(() => renderLoggedOut());
  }
})();
