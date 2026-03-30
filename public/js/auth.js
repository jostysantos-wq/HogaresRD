// HogaresRD — shared auth helper
// Load this script on every page that needs auth awareness.

const AUTH_KEY = 'hogaresrd_token';

function getToken() {
  return localStorage.getItem(AUTH_KEY);
}

function getUser() {
  const token = getToken();
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    if (payload.exp * 1000 < Date.now()) { _clearToken(); return null; }
    return payload; // { sub, role, iat, exp }
  } catch { return null; }
}

function isLoggedIn() { return !!getUser(); }

function authHeaders() {
  const token = getToken();
  return token
    ? { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };
}

function _clearToken() {
  localStorage.removeItem(AUTH_KEY);
  localStorage.removeItem('hogaresrd_user');
  localStorage.removeItem('token');
}

function logout() {
  _clearToken();
  window.location.href = '/login?logout=1';
}

// Redirect to /login if not authenticated
function requireAuth() {
  if (!isLoggedIn()) {
    window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
  }
}

// Redirect to /home if already authenticated (use on login/register pages)
function redirectIfAuth() {
  if (!isLoggedIn()) return;
  try {
    const user = JSON.parse(localStorage.getItem('hogaresrd_user') || 'null');
    const role = user?.role || JSON.parse(atob(getToken().split('.')[1]))?.role;
    window.location.href = role === 'agency' ? '/broker' : '/home';
  } catch { window.location.href = '/home'; }
}

// Fetch current user from server (returns null on error)
async function fetchMe() {
  const token = getToken();
  if (!token) return null;
  try {
    const res = await fetch('/api/auth/me', { headers: authHeaders() });
    if (!res.ok) { _clearToken(); return null; }
    return await res.json();
  } catch { return null; }
}
