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

    /* ── build dropdown HTML based on role ── */
    const proMenu = `
      <div class="_nav-section-lbl">Panel Profesional</div>
      <a href="/broker" class="_nav-dd">
        <span class="_nav-dd-left"><span class="_nav-ic">&#9783;</span> Dashboard</span>
      </a>
      <a href="/broker#mensajes" class="_nav-dd">
        <span class="_nav-dd-left"><span class="_nav-ic">&#128172;</span> Mensajes</span>
      </a>
      <a href="/broker#tour-requests" class="_nav-dd">
        <span class="_nav-dd-left"><span class="_nav-ic">&#128197;</span> Solicitudes de Tour</span>
      </a>
      <a href="/broker#availability" class="_nav-dd">
        <span class="_nav-dd-left"><span class="_nav-ic">&#128336;</span> Disponibilidad</span>
      </a>
      <a href="/broker#chat-ia" class="_nav-dd">
        <span class="_nav-dd-left"><span class="_nav-ic">&#129302;</span> Chat IA</span>
      </a>
      ${isInm ? `
      <hr class="_nav-hr">
      <div class="_nav-section-lbl">Equipo</div>
      <a href="/broker#team-members" class="_nav-dd">
        <span class="_nav-dd-left"><span class="_nav-ic">&#128101;</span> Miembros</span>
      </a>
      <a href="/broker#team-requests" class="_nav-dd">
        <span class="_nav-dd-left"><span class="_nav-ic">&#128203;</span> Solicitudes</span>
      </a>
      <a href="/broker#team-performance" class="_nav-dd">
        <span class="_nav-dd-left"><span class="_nav-ic">&#128200;</span> Rendimiento</span>
      </a>
      ` : ''}
      <hr class="_nav-hr">
      <div class="_nav-section-lbl">Cuenta</div>
      <a href="/subscription" class="_nav-dd">
        <span class="_nav-dd-left"><span class="_nav-ic">&#128179;</span> Suscripci\u00f3n</span>
      </a>
      <a href="/broker#contrasena" class="_nav-dd">
        <span class="_nav-dd-left"><span class="_nav-ic">&#128273;</span> Contrase\u00f1a</span>
      </a>
      <a href="/broker#2fa" class="_nav-dd">
        <span class="_nav-dd-left"><span class="_nav-ic">&#128737;</span> Verificaci\u00f3n 2FA</span>
      </a>`;

    const userMenu = `
      <div class="_nav-section-lbl">Mi Cuenta</div>
      <a href="/profile" class="_nav-dd">
        <span class="_nav-dd-left"><span class="_nav-ic">&#128100;</span> Mi Perfil</span>
      </a>
      <a href="/favorites" class="_nav-dd">
        <span class="_nav-dd-left"><span class="_nav-ic">&#10084;&#65039;</span> Mis Favoritos</span>
      </a>
      <a href="/my-applications" class="_nav-dd">
        <span class="_nav-dd-left"><span class="_nav-ic">&#128203;</span> Mis Aplicaciones</span>
      </a>
      <a href="/busquedas-guardadas" class="_nav-dd">
        <span class="_nav-dd-left"><span class="_nav-ic">&#128276;</span> B\u00fasquedas Guardadas</span>
      </a>
      <a href="/mensajes" class="_nav-dd">
        <span class="_nav-dd-left"><span class="_nav-ic">&#128172;</span> Mensajes</span>
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
            <span class="_nav-dd-left"><span class="_nav-ic" id="navThemeIc"></span><span id="navThemeLbl"></span></span>
            <div style="width:36px;height:20px;border-radius:50px;background:var(--toggle-bg,#CBD5E1);position:relative;flex-shrink:0;">
              <div id="navThemeKnob" style="width:16px;height:16px;border-radius:50%;background:var(--toggle-knob,#fff);position:absolute;top:2px;transition:left 0.3s;box-shadow:0 1px 3px rgba(0,0,0,0.2);"></div>
            </div>
          </div>
          <hr class="_nav-hr">
          <button class="_nav-dd" style="color:#CF142B;background:none;border:none;cursor:pointer;text-align:left;width:100%;font-family:inherit;font-size:0.9rem;" onclick="navAuthLogout()">
            <span class="_nav-dd-left"><span class="_nav-ic">&#128682;</span> Cerrar Sesi\u00f3n</span>
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
        ._nav-dd-left { display: flex; align-items: center; gap: 0.55rem; }
        ._nav-ic { font-size: 1rem; width: 1.25rem; text-align: center; flex-shrink: 0; }
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
      const ic   = document.getElementById('navThemeIc');
      const knob = document.getElementById('navThemeKnob');
      if (lbl)  lbl.textContent  = dark ? 'Modo Claro'  : 'Modo Oscuro';
      if (ic)   ic.textContent   = dark ? '\u2600\ufe0f' : '\ud83c\udf19';
      if (knob) knob.style.left  = dark ? '18px' : '2px';
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
