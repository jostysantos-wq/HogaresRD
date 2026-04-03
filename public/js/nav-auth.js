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
 */
(function () {
  'use strict';

  const area = document.getElementById('navAuthArea');
  if (!area) return;

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
    const initials  = (user.name || 'U').split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
    const firstName = (user.name || 'Usuario').split(' ')[0];

    area.innerHTML = `
      <a href="/submit" style="background:var(--accent);color:#fff;font-size:0.9rem;font-weight:600;padding:0.5rem 1.2rem;border-radius:8px;text-decoration:none;white-space:nowrap;display:inline-flex;align-items:center;gap:0.4rem;">
        <svg viewBox="0 0 24 24" style="width:15px;height:15px;fill:#fff;flex-shrink:0;"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
        Publicar
      </a>
      <div style="position:relative;" id="navUserMenu">
        <button id="navAvatarBtn" style="display:flex;align-items:center;gap:0.5rem;background:none;border:1.5px solid var(--border);border-radius:50px;padding:0.3rem 0.75rem 0.3rem 0.3rem;cursor:pointer;color:var(--text);transition:border-color 0.2s,background 0.2s;">
          <div style="width:28px;height:28px;border-radius:50%;background:var(--accent);color:#fff;font-size:0.72rem;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0;letter-spacing:0;">${initials}</div>
          <span style="font-size:0.88rem;font-weight:600;max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${firstName}</span>
          <svg viewBox="0 0 24 24" style="width:15px;height:15px;fill:currentColor;opacity:0.45;flex-shrink:0;"><path d="M7 10l5 5 5-5z"/></svg>
        </button>
        <div id="navUserDd" style="display:none;position:absolute;top:calc(100% + 8px);right:0;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;box-shadow:0 8px 40px rgba(17,17,16,0.12);min-width:200px;overflow:hidden;z-index:300;">
          <a href="/profile" class="_nav-dd">&#128100; Mi Perfil</a>
          <a href="/favorites" class="_nav-dd">&#10084;&#65039; Mis Favoritos</a>
          <a href="/my-applications" class="_nav-dd">&#128203; Mis Aplicaciones</a>
          <a href="/busquedas-guardadas" class="_nav-dd">&#128276; B\u00fasquedas Guardadas</a>
          <hr style="border:none;border-top:1px solid var(--border);margin:0.25rem 0;">
          <div class="_nav-dd _nav-dd-theme" id="navThemeToggle" onclick="event.stopPropagation();if(window.toggleTheme)window.toggleTheme();_navSyncTheme();">
            <span id="navThemeLbl"></span>
            <div style="width:36px;height:20px;border-radius:50px;background:var(--toggle-bg,#CBD5E1);position:relative;flex-shrink:0;">
              <div id="navThemeKnob" style="width:16px;height:16px;border-radius:50%;background:var(--toggle-knob,#fff);position:absolute;top:2px;transition:left 0.3s;box-shadow:0 1px 3px rgba(0,0,0,0.2);"></div>
            </div>
          </div>
          <hr style="border:none;border-top:1px solid var(--border);margin:0.25rem 0;">
          <button class="_nav-dd" style="color:#CF142B !important;background:none;border:none;cursor:pointer;text-align:left;width:100%;font-family:inherit;font-size:0.9rem;" onclick="navAuthLogout()">Cerrar Sesi\u00f3n</button>
        </div>
      </div>`;

    /* ── inject dropdown item styles (once) ─── */
    if (!document.getElementById('_navAuthStyle')) {
      const s = document.createElement('style');
      s.id = '_navAuthStyle';
      s.textContent = [
        '._nav-dd{display:flex;align-items:center;justify-content:space-between;',
        'padding:0.68rem 1.1rem;font-size:0.9rem;color:var(--text);text-decoration:none;',
        'transition:background 0.15s;gap:0.75rem;}',
        '._nav-dd:hover{background:var(--accent-light);color:var(--accent);}',
        '._nav-dd-theme{cursor:pointer;}'
      ].join('');
      document.head.appendChild(s);
    }

    /* ── sync theme indicator ─── */
    function _navSyncTheme() {
      const dark = document.documentElement.getAttribute('data-theme') === 'dark';
      const lbl  = document.getElementById('navThemeLbl');
      const knob = document.getElementById('navThemeKnob');
      if (lbl)  lbl.textContent = dark ? '\u2600\ufe0f Modo Claro' : '\ud83c\udf19 Modo Oscuro';
      if (knob) knob.style.left = dark ? '18px' : '2px';
    }
    window._navSyncTheme = _navSyncTheme;
    _navSyncTheme();

    /* ── avatar button toggle ─── */
    document.getElementById('navAvatarBtn').addEventListener('click', e => {
      e.stopPropagation();
      const dd = document.getElementById('navUserDd');
      const isOpen = dd.style.display !== 'none';
      if (!isOpen) _navSyncTheme(); // sync theme label on open
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
    // Instant render — no network call needed
    renderLoggedIn(user);
  } else {
    // No cached user. Try session cookie (httpOnly) via /api/auth/me
    // Show nothing until we know (avoids showing wrong button briefly)
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
