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

// Redirect away from login/register pages if already authenticated
function redirectIfAuth() {
  if (!isLoggedIn()) return;
  try {
    const user = getUser();
    const role = user?.role;
    if (role === 'agency' || role === 'broker' || role === 'inmobiliaria') {
      window.location.href = '/broker';
    } else {
      window.location.href = '/home';
    }
  } catch { window.location.href = '/home'; }
}

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
