// HogaresRD — shared auth helper
// Load this script on every page that needs auth awareness.

// ── User object ─────────────────────────────────────────────────────────────
// The JWT now lives in an httpOnly cookie and is never readable by JS.
// For display purposes (name, role) we store only the user object in localStorage.

function getUser() {
  try {
    const raw = localStorage.getItem('hogaresrd_user');
    if (!raw) return null;
    const user = JSON.parse(raw);
    // Basic sanity check
    if (!user || !user.id) return null;
    return user;
  } catch { return null; }
}

function isLoggedIn() { return !!getUser(); }

// Returns headers suitable for fetch() calls.
// The JWT cookie is sent automatically by the browser (same-origin).
// Authorization header is kept only for API clients / backward compat.
function authHeaders() {
  return { 'Content-Type': 'application/json' };
}

function _clearLocal() {
  localStorage.removeItem('hogaresrd_token'); // legacy — remove if present
  localStorage.removeItem('hogaresrd_user');
  localStorage.removeItem('token');
}

async function logout() {
  // Tell the server to clear the httpOnly cookie
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
  _clearLocal();
  window.location.href = '/home';
}

// Redirect to /login if not authenticated
function requireAuth() {
  if (!isLoggedIn()) {
    window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
  }
}

// Redirect away from login/register pages if already authenticated.
// Verifies the session with the server to ensure the JWT cookie is still valid.
async function redirectIfAuth() {
  if (!isLoggedIn()) return;
  // Verify cookie is still valid before redirecting
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include' });
    if (res.status === 401) {
      // Cookie expired or revoked — clear stale localStorage and stay on login
      _clearLocal();
      return;
    }
    if (!res.ok) return;
    const user = await res.json();
    if (!user) return;
    const role = user?.role;
    if (role === 'agency' || role === 'broker' || role === 'inmobiliaria') {
      window.location.href = '/broker';
    } else {
      window.location.href = '/home';
    }
  } catch { /* network error — stay on login page */ }
}

// ── Idle session timeout (pro roles only) ────────────────────────────────────
// Brokers and inmobiliarias handle sensitive listing/client data, so we
// automatically log them out after 20 minutes of inactivity.
// A 60-second warning modal appears before the final logout.

(function initIdleTimeout() {
  const PRO_ROLES       = ['agency', 'broker', 'inmobiliaria'];
  const IDLE_MS         = 20 * 60 * 1000;  // 20 minutes idle → show warning
  const COUNTDOWN_SEC   = 60;              // 60-second countdown before logout

  const user = getUser();
  if (!user || !PRO_ROLES.includes(user.role)) return; // free accounts: no timeout

  let idleTimer, countdownTimer, secondsLeft;

  // ── Inject warning modal (only once) ───────────────────────────────────────
  if (!document.getElementById('idle-modal')) {
    const modal = document.createElement('div');
    modal.id = 'idle-modal';
    modal.innerHTML = `
      <div id="idle-modal-box">
        <div id="idle-modal-icon">🔒</div>
        <h3>¿Sigues ahí?</h3>
        <p>Por seguridad, tu sesión se cerrará en <strong id="idle-countdown">${COUNTDOWN_SEC}</strong> segundos por inactividad.</p>
        <div id="idle-modal-actions">
          <button id="idle-stay-btn">Seguir conectado</button>
          <button id="idle-logout-btn">Cerrar sesión</button>
        </div>
      </div>
    `;
    const style = document.createElement('style');
    style.textContent = `
      #idle-modal {
        display: none; position: fixed; inset: 0; z-index: 99999;
        background: rgba(0,0,0,.55); backdrop-filter: blur(4px);
        align-items: center; justify-content: center;
      }
      #idle-modal.visible { display: flex; }
      #idle-modal-box {
        background: var(--card-bg, #fff); border-radius: 16px;
        padding: 2rem 2.5rem; max-width: 380px; width: 90%;
        text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,.25);
        animation: idleSlideIn .25s ease;
      }
      @keyframes idleSlideIn { from { transform: translateY(-20px); opacity:0 } to { transform: translateY(0); opacity:1 } }
      #idle-modal-icon { font-size: 2.5rem; margin-bottom: .5rem; }
      #idle-modal-box h3 { margin: 0 0 .5rem; font-size: 1.25rem; }
      #idle-modal-box p  { margin: 0 0 1.5rem; color: var(--text-muted, #666); font-size: .95rem; }
      #idle-countdown { color: #e53e3e; font-weight: 700; }
      #idle-modal-actions { display: flex; gap: .75rem; justify-content: center; }
      #idle-stay-btn {
        background: var(--accent, #2563eb); color: #fff;
        border: none; border-radius: 8px; padding: .6rem 1.4rem;
        font-size: .95rem; font-weight: 600; cursor: pointer;
      }
      #idle-logout-btn {
        background: transparent; color: var(--text-muted, #666);
        border: 1px solid var(--border, #ddd); border-radius: 8px;
        padding: .6rem 1.4rem; font-size: .95rem; cursor: pointer;
      }
      #idle-stay-btn:hover   { opacity: .9; }
      #idle-logout-btn:hover { background: var(--bg-alt, #f5f5f5); }
    `;
    document.head.appendChild(style);
    document.body.appendChild(modal);

    document.getElementById('idle-stay-btn').addEventListener('click', resetIdle);
    document.getElementById('idle-logout-btn').addEventListener('click', () => logout());
  }

  function showWarning() {
    secondsLeft = COUNTDOWN_SEC;
    document.getElementById('idle-countdown').textContent = secondsLeft;
    document.getElementById('idle-modal').classList.add('visible');

    countdownTimer = setInterval(() => {
      secondsLeft--;
      const el = document.getElementById('idle-countdown');
      if (el) el.textContent = secondsLeft;
      if (secondsLeft <= 0) {
        clearInterval(countdownTimer);
        logout();
      }
    }, 1000);
  }

  function hideWarning() {
    document.getElementById('idle-modal')?.classList.remove('visible');
    clearInterval(countdownTimer);
  }

  function resetIdle() {
    hideWarning();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(showWarning, IDLE_MS);
  }

  // Track any user activity
  ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click'].forEach(evt =>
    document.addEventListener(evt, resetIdle, { passive: true })
  );

  // Start the timer
  resetIdle();
})();

// Fetch current user from server (always fresh from DB)
async function fetchMe() {
  if (!isLoggedIn()) return null;
  try {
    const res = await fetch('/api/auth/me', { headers: authHeaders() });
    if (res.status === 401) { _clearLocal(); return null; }
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}
