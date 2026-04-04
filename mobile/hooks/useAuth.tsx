import React, {
  createContext, useContext, useEffect, useState, useCallback,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { API_BASE } from '@/constants/api';
import { SECURE_KEYS } from './useBiometric';

// ── Types ─────────────────────────────────────────────────────────────────

export interface AuthUser {
  id:     string;
  name:   string;
  email:  string;
  role:   string;
  phone?: string;
}

interface AuthContextType {
  user:               AuthUser | null;
  token:              string | null;
  loading:            boolean;
  /** True after first successful email/password login this session (for enrollment prompt). */
  justLoggedIn:       boolean;
  clearJustLoggedIn:  () => void;
  login:              (email: string, password: string) => Promise<void>;
  loginWithBiometric: (bioToken: string, bioUser: AuthUser) => Promise<void>;
  register:           (name: string, email: string, password: string, phone?: string) => Promise<void>;
  logout:             () => Promise<void>;
  /** Returns headers for authenticated API calls. */
  authHeaders:        () => Record<string, string>;
}

const AuthContext = createContext<AuthContextType | null>(null);

const TOKEN_KEY = SECURE_KEYS.token;
const LEGACY_KEY = 'hogaresrd_token'; // AsyncStorage key for migration

// ── Provider ──────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user,          setUser]          = useState<AuthUser | null>(null);
  const [token,         setToken]         = useState<string | null>(null);
  const [loading,       setLoading]       = useState(true);
  const [justLoggedIn,  setJustLoggedIn]  = useState(false);

  const clearJustLoggedIn = useCallback(() => setJustLoggedIn(false), []);

  // Restore saved session on mount (with AsyncStorage → SecureStore migration)
  useEffect(() => {
    (async () => {
      try {
        // Try SecureStore first
        let saved = await SecureStore.getItemAsync(TOKEN_KEY);

        // Migrate from AsyncStorage if needed
        if (!saved) {
          const legacy = await AsyncStorage.getItem(LEGACY_KEY);
          if (legacy) {
            saved = legacy;
            await SecureStore.setItemAsync(TOKEN_KEY, legacy);
            await AsyncStorage.removeItem(LEGACY_KEY);
          }
        }

        if (saved) {
          const res = await fetch(`${API_BASE}/auth/me`, {
            headers: { Authorization: `Bearer ${saved}` },
          });
          if (res.ok) {
            const u = await res.json();
            setToken(saved);
            setUser(u);
          } else {
            await SecureStore.deleteItemAsync(TOKEN_KEY);
          }
        }
      } catch {}
      setLoading(false);
    })();
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al iniciar sesión');
    await SecureStore.setItemAsync(TOKEN_KEY, data.token);
    setToken(data.token);
    setUser(data.user);
    setJustLoggedIn(true);
  }, []);

  // Accept biometric login result (token + user already obtained by useBiometric)
  const loginWithBiometric = useCallback(async (bioToken: string, bioUser: AuthUser) => {
    await SecureStore.setItemAsync(TOKEN_KEY, bioToken);
    setToken(bioToken);
    setUser(bioUser);
  }, []);

  const register = useCallback(async (
    name: string, email: string, password: string, phone?: string,
  ) => {
    const res = await fetch(`${API_BASE}/auth/register`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name, email, password, phone }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al crear la cuenta');
    // Auto-login after successful registration
    await login(email, password);
  }, [login]);

  const logout = useCallback(async () => {
    try {
      if (token) {
        await fetch(`${API_BASE}/auth/logout`, {
          method:  'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
      }
    } catch {}
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    setToken(null);
    setUser(null);
    setJustLoggedIn(false);
  }, [token]);

  const authHeaders = useCallback((): Record<string, string> => {
    const base: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) base['Authorization'] = `Bearer ${token}`;
    return base;
  }, [token]);

  return (
    <AuthContext.Provider value={{
      user, token, loading, justLoggedIn, clearJustLoggedIn,
      login, loginWithBiometric, register, logout, authHeaders,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

// ── Hook ──────────────────────────────────────────────────────────────────

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
