import { useState, useEffect, useCallback } from 'react';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { endpoints } from '@/constants/api';

// ── SecureStore keys ─────────────────────────────────────────────────────
export const SECURE_KEYS = {
  token:              'hogaresrd_token',
  biometricToken:     'hogaresrd_biometric_token',
  biometricEmail:     'hogaresrd_biometric_email',
  biometricEnabled:   'hogaresrd_biometric_enabled',
  biometricDismissed: 'hogaresrd_biometric_dismissed',
  lockEnabled:        'hogaresrd_lock_enabled',
  lockTimeout:        'hogaresrd_lock_timeout',
};

// ── Types ────────────────────────────────────────────────────────────────

export interface BiometricLoginResult {
  token: string;
  user:  { id: string; name: string; email: string; role: string; phone?: string };
}

export interface UseBiometricReturn {
  isAvailable:   boolean;
  isEnabled:     boolean;
  biometricType: string | null; // 'Face ID' | 'Touch ID' | null
  loading:       boolean;
  wasDismissed:  boolean;
  enable:        (authToken: string) => Promise<void>;
  disable:       (authToken: string) => Promise<void>;
  authenticate:  () => Promise<BiometricLoginResult>;
  dismiss:       () => Promise<void>;
  promptLocal:   () => Promise<boolean>;
}

// ── Hook ─────────────────────────────────────────────────────────────────

export function useBiometric(): UseBiometricReturn {
  const [isAvailable,   setAvailable]   = useState(false);
  const [isEnabled,     setEnabled]     = useState(false);
  const [biometricType, setBioType]     = useState<string | null>(null);
  const [loading,       setLoading]     = useState(true);
  const [wasDismissed,  setDismissed]   = useState(false);

  // Check hardware + stored state on mount
  useEffect(() => {
    (async () => {
      try {
        const hasHardware = await LocalAuthentication.hasHardwareAsync();
        const isEnrolled  = await LocalAuthentication.isEnrolledAsync();
        setAvailable(hasHardware && isEnrolled);

        if (hasHardware && isEnrolled) {
          const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
          if (types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)) {
            setBioType('Face ID');
          } else if (types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)) {
            setBioType('Touch ID');
          }
        }

        const enabled = await SecureStore.getItemAsync(SECURE_KEYS.biometricEnabled);
        setEnabled(enabled === 'true');

        const dismissed = await SecureStore.getItemAsync(SECURE_KEYS.biometricDismissed);
        setDismissed(dismissed === 'true');
      } catch {}
      setLoading(false);
    })();
  }, []);

  // Prompt local biometric (no server call — just device verification)
  const promptLocal = useCallback(async (): Promise<boolean> => {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Verifica tu identidad',
      cancelLabel: 'Cancelar',
      disableDeviceFallback: false,
    });
    return result.success;
  }, []);

  // Enable biometric: local prompt + server registration
  const enable = useCallback(async (authToken: string) => {
    const localOk = await promptLocal();
    if (!localOk) throw new Error('Verificación biométrica cancelada');

    const res = await fetch(endpoints.biometricRegister, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al registrar biométrico');

    // Read email from current session token
    const meRes = await fetch(endpoints.me, {
      headers: { 'Authorization': `Bearer ${authToken}` },
    });
    const meData = await meRes.json();

    await SecureStore.setItemAsync(SECURE_KEYS.biometricToken, data.biometricToken);
    await SecureStore.setItemAsync(SECURE_KEYS.biometricEmail, meData.email);
    await SecureStore.setItemAsync(SECURE_KEYS.biometricEnabled, 'true');
    await SecureStore.setItemAsync(SECURE_KEYS.lockEnabled, 'true');
    setEnabled(true);
  }, [promptLocal]);

  // Disable biometric: server revocation + clear SecureStore
  const disable = useCallback(async (authToken: string) => {
    try {
      await fetch(endpoints.biometricRevoke, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${authToken}`,
        },
      });
    } catch {} // revoke is best-effort

    await SecureStore.deleteItemAsync(SECURE_KEYS.biometricToken);
    await SecureStore.deleteItemAsync(SECURE_KEYS.biometricEmail);
    await SecureStore.deleteItemAsync(SECURE_KEYS.biometricEnabled);
    await SecureStore.deleteItemAsync(SECURE_KEYS.lockEnabled);
    setEnabled(false);
  }, []);

  // Full biometric login: local prompt + server authentication
  const authenticate = useCallback(async (): Promise<BiometricLoginResult> => {
    const localOk = await promptLocal();
    if (!localOk) throw new Error('Verificación biométrica cancelada');

    const email = await SecureStore.getItemAsync(SECURE_KEYS.biometricEmail);
    const bioToken = await SecureStore.getItemAsync(SECURE_KEYS.biometricToken);

    if (!email || !bioToken) {
      // Enrollment was cleared — clean up
      await SecureStore.deleteItemAsync(SECURE_KEYS.biometricEnabled);
      setEnabled(false);
      throw new Error('Biométrico no configurado. Inicia sesión con tu contraseña.');
    }

    const res = await fetch(endpoints.biometricLogin, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, biometricToken: bioToken }),
    });
    const data = await res.json();

    if (!res.ok) {
      // Token may have been revoked server-side
      if (res.status === 401) {
        await SecureStore.deleteItemAsync(SECURE_KEYS.biometricToken);
        await SecureStore.deleteItemAsync(SECURE_KEYS.biometricEmail);
        await SecureStore.deleteItemAsync(SECURE_KEYS.biometricEnabled);
        setEnabled(false);
      }
      throw new Error(data.error || 'Error al autenticar');
    }

    return { token: data.token, user: data.user };
  }, [promptLocal]);

  // Dismiss enrollment prompt permanently
  const dismiss = useCallback(async () => {
    await SecureStore.setItemAsync(SECURE_KEYS.biometricDismissed, 'true');
    setDismissed(true);
  }, []);

  return {
    isAvailable, isEnabled, biometricType, loading, wasDismissed,
    enable, disable, authenticate, dismiss, promptLocal,
  };
}
