import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, ActivityIndicator,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, shadow } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { useBiometric } from '@/hooks/useBiometric';

interface Props {
  visible:  boolean;
  onClose:  () => void;
}

export default function BiometricEnrollSheet({ visible, onClose }: Props) {
  const { token, clearJustLoggedIn } = useAuth();
  const { biometricType, enable, dismiss } = useBiometric();

  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');

  const iconName = biometricType === 'Face ID' ? 'scan-outline' : 'finger-print-outline';

  async function handleEnable() {
    if (!token) return;
    setError('');
    setLoading(true);
    try {
      await enable(token);
      clearJustLoggedIn();
      onClose();
    } catch (e: any) {
      setError(e.message || 'Error al activar');
    }
    setLoading(false);
  }

  function handleLater() {
    clearJustLoggedIn();
    onClose();
  }

  async function handleNever() {
    await dismiss();
    clearJustLoggedIn();
    onClose();
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
    >
      <View style={styles.backdrop}>
        <BlurView intensity={40} tint="dark" style={StyleSheet.absoluteFill} />

        <View style={styles.card}>
          <View style={styles.iconWrap}>
            <Ionicons name={iconName as any} size={48} color={colors.primary} />
          </View>

          <Text style={styles.title}>
            {biometricType === 'Face ID'
              ? 'Iniciar sesion con Face ID?'
              : 'Iniciar sesion con Touch ID?'}
          </Text>

          <Text style={styles.body}>
            La proxima vez podras acceder a tu cuenta sin escribir tu contrasena.
          </Text>

          {error ? (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle-outline" size={14} color={colors.danger} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <TouchableOpacity
            style={[styles.primaryBtn, loading && styles.btnDisabled]}
            onPress={handleEnable}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.primaryBtnText}>Activar {biometricType}</Text>
            }
          </TouchableOpacity>

          <TouchableOpacity style={styles.secondaryBtn} onPress={handleLater}>
            <Text style={styles.secondaryBtnText}>Ahora no</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={handleNever}>
            <Text style={styles.neverText}>No mostrar de nuevo</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: 28,
    width: '100%',
    alignItems: 'center',
    ...shadow.md,
  },
  iconWrap: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: colors.accentLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  title: {
    fontSize: 20,
    fontWeight: '800',
    color: colors.primary,
    textAlign: 'center',
    marginBottom: 10,
  },
  body: {
    fontSize: 14,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 24,
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#FEF2F2',
    borderRadius: radius.sm,
    padding: 10,
    marginBottom: 12,
    width: '100%',
  },
  errorText: { fontSize: 13, color: colors.danger, flex: 1 },
  primaryBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    height: 50,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  btnDisabled: { opacity: 0.6 },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  secondaryBtn: {
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.md,
    height: 44,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  secondaryBtnText: { color: colors.textMuted, fontSize: 15, fontWeight: '600' },
  neverText: {
    fontSize: 13,
    color: colors.textLight,
    textDecorationLine: 'underline',
  },
});
