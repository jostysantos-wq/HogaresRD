// Change this to your deployed server URL for production.
// For local testing: use your Mac's local IP (e.g. http://192.168.1.X:3000)
// so your iPhone on the same Wi-Fi can reach the backend.
export const API_BASE = 'http://192.168.1.175:3000/api';

export const endpoints = {
  // Listings
  listings:      `${API_BASE}/listings`,
  trending:      `${API_BASE}/listings/trending`,
  agencies:      `${API_BASE}/listings/agencies`,
  constructoras: `${API_BASE}/listings/constructoras`,
  listing:       (id: string)   => `${API_BASE}/listings/${id}`,
  agency:        (slug: string) => `${API_BASE}/listings/agencies/${slug}`,
  inquiry:       (id: string)   => `${API_BASE}/listings/${id}/inquiry`,

  // Auth
  login:    `${API_BASE}/auth/login`,
  register: `${API_BASE}/auth/register`,
  logout:   `${API_BASE}/auth/logout`,
  me:       `${API_BASE}/auth/me`,

  // User
  profile:      `${API_BASE}/user/profile`,
  applications: `${API_BASE}/applications/my`,

  // Conversations (chat)
  conversations:    `${API_BASE}/conversations`,
  conversation:     (id: string) => `${API_BASE}/conversations/${id}`,
  convMessages:     (id: string) => `${API_BASE}/conversations/${id}/messages`,
  convRead:         (id: string) => `${API_BASE}/conversations/${id}/read`,
  unreadCount:      `${API_BASE}/conversations/unread`,
};
