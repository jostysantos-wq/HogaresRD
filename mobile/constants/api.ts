// Change this to your deployed server URL for production.
// For local testing: use your Mac's local IP (e.g. http://192.168.1.X:3000)
// so your iPhone on the same Wi-Fi can reach the backend.
export const API_BASE = 'http://localhost:3000/api';

export const endpoints = {
  listings: `${API_BASE}/listings`,
  trending: `${API_BASE}/listings/trending`,
  agencies: `${API_BASE}/listings/agencies`,
  constructoras: `${API_BASE}/listings/constructoras`,
  listing: (id: string) => `${API_BASE}/listings/${id}`,
  agency: (slug: string) => `${API_BASE}/listings/agencies/${slug}`,
  inquiry: (id: string) => `${API_BASE}/listings/${id}/inquiry`,
};
