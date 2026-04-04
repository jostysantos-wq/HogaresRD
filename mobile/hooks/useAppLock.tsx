import React, {
  createContext, useContext, useEffect, useState, useCallback, useRef,
} from 'react';
import { AppState, AppStateStatus } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { SECURE_KEYS } from './useBiometric';
import { useAuth } from './useAuth';

// ── Types ────────────────────────────────────────────────────────────────

interface AppLockContextType {
  isLocked:            boolean;
  lockEnabled:         boolean;
  idleTimeoutMinutes:  number;
  setLockEnabled:      (enabled: boolean) => Promise<void>;
  setIdleTimeout:      (minutes: number) => Promise<void>;
  unlock:              () => void;
  lock:                () => void;
}

const AppLockContext = createContext<AppLockContextType | null>(null);

const DEFAULT_TIMEOUT = 5; // minutes

// ── Provider ─────────────────────────────────────────────────────────────

export function AppLockProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();

  const [isLocked,           setIsLocked]    = useState(false);
  const [lockEnabled,        setLockState]   = useState(false);
  const [idleTimeoutMinutes, setTimeoutState] = useState(DEFAULT_TIMEOUT);

  const backgroundTimestamp = useRef<number | null>(null);

  // Load preferences on mount
  useEffect(() => {
    (async () => {
      const enabled = await SecureStore.getItemAsync(SECURE_KEYS.lockEnabled);
      setLockState(enabled === 'true');

      const timeout = await SecureStore.getItemAsync(SECURE_KEYS.lockTimeout);
      if (timeout) setTimeoutState(parseInt(timeout, 10) || DEFAULT_TIMEOUT);
    })();
  }, []);

  // Listen for app state changes
  useEffect(() => {
    function handleAppState(next: AppStateStatus) {
      if (!user || !lockEnabled) return;

      if (next === 'background' || next === 'inactive') {
        backgroundTimestamp.current = Date.now();
      } else if (next === 'active' && backgroundTimestamp.current) {
        const elapsed = Date.now() - backgroundTimestamp.current;
        const timeoutMs = idleTimeoutMinutes * 60 * 1000;
        backgroundTimestamp.current = null;

        if (elapsed >= timeoutMs) {
          setIsLocked(true);
        }
      }
    }

    const sub = AppState.addEventListener('change', handleAppState);
    return () => sub.remove();
  }, [user, lockEnabled, idleTimeoutMinutes]);

  // Reset lock when user logs out
  useEffect(() => {
    if (!user) setIsLocked(false);
  }, [user]);

  const setLockEnabled = useCallback(async (enabled: boolean) => {
    await SecureStore.setItemAsync(SECURE_KEYS.lockEnabled, enabled ? 'true' : 'false');
    setLockState(enabled);
    if (!enabled) setIsLocked(false);
  }, []);

  const setIdleTimeout = useCallback(async (minutes: number) => {
    await SecureStore.setItemAsync(SECURE_KEYS.lockTimeout, String(minutes));
    setTimeoutState(minutes);
  }, []);

  const unlock = useCallback(() => setIsLocked(false), []);
  const lock   = useCallback(() => setIsLocked(true), []);

  return (
    <AppLockContext.Provider value={{
      isLocked, lockEnabled, idleTimeoutMinutes,
      setLockEnabled, setIdleTimeout, unlock, lock,
    }}>
      {children}
    </AppLockContext.Provider>
  );
}

// ── Hook ─────────────────────────────────────────────────────────────────

export function useAppLock(): AppLockContextType {
  const ctx = useContext(AppLockContext);
  if (!ctx) throw new Error('useAppLock must be used inside <AppLockProvider>');
  return ctx;
}
