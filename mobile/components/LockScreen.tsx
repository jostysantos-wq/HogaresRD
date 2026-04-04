import React, { useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { colors } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { useAppLock } from '@/hooks/useAppLock';
import { useBiometric } from '@/hooks/useBiometric';
import LogoMark from './LogoMark';

export default function LockScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, logout } = useAuth();
  const { unlock } = useAppLock();
  const { biometricType, promptLocal, isEnabled } = useBiometric();

  const [error,   setError]   = useState('');
  const [loading, setLoading] = useState(false);

  // Auto-trigger biometric on mount
  useEffect(() => {
    const timer = setTimeout(() => handleUnlock(), 500);
    return () => clearTimeout(timer);
  }, []);

  async function handleUnlock() {
    setError('');
    setLoading(true);
    try {
      const ok = await promptLocal();
      if (ok) {
        unlock();
      } else {
        setError('Verificacion cancelada');
      }
    } catch {
      setError('Error al verificar');
    }
    setLoading(false);
  }

  async function handleLogout() {
    await logout();
    unlock();
    router.replace('/auth/login');
  }

  const iconName = biometricType === 'Face ID' ? 'scan-outline' : 'finger-print-outline';

  return (
    <View style={[styles.container, { paddingTop: insets.top + 60 }]}>
      <LogoMark size={56} showName light />

      <View style={styles.spacer} />

      {user && (
        <View style={styles.userSection}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {user.name.charAt(0).toUpperCase()}
            </Text>
          </View>
          <Text style={styles.userName}>{user.name}</Text>
        </View>
      )}

      <TouchableOpacity
        style={styles.bioButton}
        onPress={handleUnlock}
        disabled={loading}
        activeOpacity={0.7}
      >
        {loading ? (
          <ActivityIndicator color="#fff" size="large" />
        ) : (
          <Ionicons name={iconName as any} size={56} color="#fff" />
        )}
      </TouchableOpacity>

      <Text style={styles.hint}>
        {biometricType
          ? `Usa ${biometricType} para continuar`
          : 'Toca para desbloquear'}
      </Text>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.bottom}>
        <TouchableOpacity onPress={handleLogout}>
          <Text style={styles.fallbackText}>Cerrar sesion</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.primary,
    alignItems: 'center',
    zIndex: 9999,
  },
  spacer: { height: 60 },
  userSection: {
    alignItems: 'center',
    marginBottom: 40,
  },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.4)',
  },
  avatarText: { fontSize: 30, fontWeight: '800', color: '#fff' },
  userName:   { fontSize: 18, fontWeight: '700', color: '#fff' },
  bioButton: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  hint: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.7)',
    marginBottom: 8,
  },
  error: {
    fontSize: 13,
    color: '#FF6B6B',
    marginTop: 4,
  },
  bottom: {
    position: 'absolute',
    bottom: 60,
    alignItems: 'center',
  },
  fallbackText: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.6)',
    textDecorationLine: 'underline',
  },
});
