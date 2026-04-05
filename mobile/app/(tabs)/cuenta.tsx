import React, { useState, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Switch,
  ScrollView, ActivityIndicator, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, shadow } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { useBiometric } from '@/hooks/useBiometric';
import { useAppLock } from '@/hooks/useAppLock';
import BiometricEnrollSheet from '@/components/BiometricEnrollSheet';

const ROLE_LABELS: Record<string, string> = {
  user:          'Cliente',
  broker:        'Agente',
  agency:        'Agencia',
  inmobiliaria:  'Inmobiliaria',
  constructora:  'Constructora',
  admin:         'Administrador',
};

const ROLE_COLORS: Record<string, string> = {
  user:          colors.accent,
  broker:        '#7C3AED',
  agency:        '#B45309',
  inmobiliaria:  '#065F46',
  constructora:  '#B34D04',
  admin:         colors.danger,
};

const TIMEOUT_OPTIONS = [1, 2, 5, 10, 15];

function MenuItem({
  icon, label, onPress, danger = false,
}: {
  icon: string; label: string; onPress: () => void; danger?: boolean;
}) {
  return (
    <TouchableOpacity style={styles.menuItem} onPress={onPress} activeOpacity={0.75}>
      <View style={[styles.menuIcon, danger && styles.menuIconDanger]}>
        <Ionicons name={icon as any} size={20} color={danger ? colors.danger : colors.primary} />
      </View>
      <Text style={[styles.menuLabel, danger && styles.menuLabelDanger]}>{label}</Text>
      {!danger && <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />}
    </TouchableOpacity>
  );
}

function ToggleRow({
  icon, label, value, onValueChange, disabled = false,
}: {
  icon: string; label: string; value: boolean; onValueChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <View style={[styles.menuItem, disabled && { opacity: 0.5 }]}>
      <View style={styles.menuIcon}>
        <Ionicons name={icon as any} size={20} color={colors.primary} />
      </View>
      <Text style={styles.menuLabel}>{label}</Text>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{ false: colors.border, true: colors.accent }}
        thumbColor="#fff"
      />
    </View>
  );
}

export default function CuentaScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, token, loading, justLoggedIn, clearJustLoggedIn, logout } = useAuth();
  const bio = useBiometric();
  const lock = useAppLock();

  const [showEnroll, setShowEnroll] = useState(false);
  const [bioSwitching, setBioSwitching] = useState(false);

  // Show enrollment prompt after first email/password login
  useEffect(() => {
    if (justLoggedIn && bio.isAvailable && !bio.isEnabled && !bio.wasDismissed && !bio.loading) {
      const timer = setTimeout(() => setShowEnroll(true), 800);
      return () => clearTimeout(timer);
    }
  }, [justLoggedIn, bio.isAvailable, bio.isEnabled, bio.wasDismissed, bio.loading]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  // ── Not logged in ─────────────────────────────────────────────────────────
  if (!user) {
    return (
      <View style={[styles.guestContainer, { paddingTop: insets.top + 40 }]}>
        <View style={styles.guestIconWrap}>
          <Ionicons name="person-circle-outline" size={80} color={colors.border} />
        </View>
        <Text style={styles.guestTitle}>Tu cuenta</Text>
        <Text style={styles.guestSub}>
          Inicia sesion para guardar favoritos, hacer seguimiento de aplicaciones y chatear con agentes.
        </Text>

        <TouchableOpacity
          style={styles.loginBtn}
          onPress={() => router.push('/auth/login')}
          activeOpacity={0.85}
        >
          <Text style={styles.loginBtnText}>Iniciar sesion</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.registerBtn}
          onPress={() => router.push('/auth/register')}
          activeOpacity={0.85}
        >
          <Text style={styles.registerBtnText}>Crear cuenta gratis</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Logged in ─────────────────────────────────────────────────────────────
  const roleColor = ROLE_COLORS[user.role] || colors.accent;
  const roleLabel = ROLE_LABELS[user.role] || user.role;

  function confirmLogout() {
    Alert.alert(
      'Cerrar sesion',
      'Estas seguro que quieres cerrar sesion?',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Cerrar sesion',
          style: 'destructive',
          onPress: async () => {
            await logout();
          },
        },
      ],
    );
  }

  async function handleBioToggle(enabled: boolean) {
    if (!token) return;
    setBioSwitching(true);
    try {
      if (enabled) {
        await bio.enable(token);
      } else {
        Alert.alert(
          `Desactivar ${bio.biometricType || 'biometrico'}`,
          'Tendras que usar tu contrasena para iniciar sesion.',
          [
            { text: 'Cancelar', style: 'cancel', onPress: () => setBioSwitching(false) },
            {
              text: 'Desactivar',
              style: 'destructive',
              onPress: async () => {
                await bio.disable(token);
                await lock.setLockEnabled(false);
                setBioSwitching(false);
              },
            },
          ],
        );
        return;
      }
    } catch (e: any) {
      Alert.alert('Error', e.message || 'No se pudo cambiar la configuracion');
    }
    setBioSwitching(false);
  }

  function handleTimeoutPress() {
    const buttons: { text: string; onPress?: () => void }[] = TIMEOUT_OPTIONS.map(min => ({
      text: `${min} min${min > 1 ? 'utos' : 'uto'}`,
      onPress: () => { lock.setIdleTimeout(min); },
    }));
    buttons.push({ text: 'Cancelar' });

    Alert.alert(
      'Tiempo de bloqueo',
      'Bloquear la app despues de:',
      buttons,
    );
  }

  return (
    <>
      <ScrollView
        style={styles.container}
        contentContainerStyle={{ paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Profile header */}
        <View style={[styles.profileHeader, { paddingTop: insets.top + 24 }]}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>
              {user.name.charAt(0).toUpperCase()}
            </Text>
          </View>
          <Text style={styles.userName}>{user.name}</Text>
          <Text style={styles.userEmail}>{user.email}</Text>
          <View style={[styles.rolePill, { backgroundColor: roleColor + '22' }]}>
            <Text style={[styles.rolePillText, { color: roleColor }]}>{roleLabel}</Text>
          </View>
        </View>

        {/* Menu items */}
        <View style={styles.menuCard}>
          <MenuItem
            icon="document-text-outline"
            label="Mis Aplicaciones"
            onPress={() => router.push('/mis-aplicaciones')}
          />
          <View style={styles.menuDivider} />
          <MenuItem
            icon="chatbubbles-outline"
            label="Mensajes"
            onPress={() => router.push('/mensajes')}
          />
          <View style={styles.menuDivider} />
          <MenuItem
            icon="heart-outline"
            label="Propiedades guardadas"
            onPress={() => router.push('/favoritos')}
          />
        </View>

        {/* Security section — only when biometric hardware is available */}
        {bio.isAvailable && (
          <View style={styles.menuCard}>
            <View style={styles.sectionLabel}>
              <Ionicons name="shield-checkmark-outline" size={14} color={colors.textMuted} />
              <Text style={styles.sectionLabelText}>SEGURIDAD</Text>
            </View>

            <ToggleRow
              icon="finger-print-outline"
              label={bio.biometricType || 'Biometrico'}
              value={bio.isEnabled}
              onValueChange={handleBioToggle}
              disabled={bioSwitching}
            />
            <View style={styles.menuDivider} />
            <ToggleRow
              icon="timer-outline"
              label="Bloqueo automatico"
              value={lock.lockEnabled}
              onValueChange={(v) => lock.setLockEnabled(v)}
              disabled={!bio.isEnabled}
            />
            {lock.lockEnabled && bio.isEnabled && (
              <>
                <View style={styles.menuDivider} />
                <TouchableOpacity style={styles.menuItem} onPress={handleTimeoutPress}>
                  <View style={styles.menuIcon}>
                    <Ionicons name="time-outline" size={20} color={colors.primary} />
                  </View>
                  <Text style={styles.menuLabel}>Tiempo de inactividad</Text>
                  <Text style={styles.timeoutValue}>{lock.idleTimeoutMinutes} min</Text>
                  <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
                </TouchableOpacity>
              </>
            )}
          </View>
        )}

        {/* Admin section — only for admin role */}
        {user.role === 'admin' && (
          <View style={styles.menuCard}>
            <MenuItem
              icon="shield-checkmark-outline"
              label="Panel de Admin (Web)"
              onPress={() => {
                const { Linking } = require('react-native');
                Linking.openURL('https://hogaresrd.com/214de22e9b0921be9dd66e26a645be4b4106');
              }}
            />
          </View>
        )}

        {/* Danger zone */}
        <View style={styles.menuCard}>
          <MenuItem
            icon="log-out-outline"
            label="Cerrar sesion"
            onPress={confirmLogout}
            danger
          />
        </View>
      </ScrollView>

      {/* Biometric enrollment prompt */}
      <BiometricEnrollSheet
        visible={showEnroll}
        onClose={() => {
          setShowEnroll(false);
          clearJustLoggedIn();
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  container:  { flex: 1, backgroundColor: colors.bg },
  center:     { flex: 1, alignItems: 'center', justifyContent: 'center' },

  // ── Guest ──
  guestContainer: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: 32,
    backgroundColor: colors.bg,
  },
  guestIconWrap: { marginBottom: 16 },
  guestTitle: {
    fontSize: 26,
    fontWeight: '900',
    color: colors.primary,
    marginBottom: 10,
    textAlign: 'center',
  },
  guestSub: {
    fontSize: 14,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 36,
  },
  loginBtn: {
    width: '100%',
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    height: 50,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
    ...shadow.sm,
  },
  loginBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  registerBtn: {
    width: '100%',
    borderWidth: 1.5,
    borderColor: colors.primary,
    borderRadius: radius.md,
    height: 50,
    alignItems: 'center',
    justifyContent: 'center',
  },
  registerBtnText: { color: colors.primary, fontSize: 15, fontWeight: '700' },

  // ── Logged in ──
  profileHeader: {
    backgroundColor: colors.primary,
    alignItems: 'center',
    paddingBottom: 32,
    paddingHorizontal: 24,
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
  avatarText:   { fontSize: 30, fontWeight: '800', color: '#fff' },
  userName:     { fontSize: 20, fontWeight: '800', color: '#fff', marginBottom: 2 },
  userEmail:    { fontSize: 13, color: 'rgba(255,255,255,0.7)', marginBottom: 10 },
  rolePill: {
    paddingHorizontal: 14,
    paddingVertical: 4,
    borderRadius: 20,
  },
  rolePillText: { fontSize: 12, fontWeight: '700' },

  menuCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    marginHorizontal: 16,
    marginTop: 20,
    overflow: 'hidden',
    ...shadow.sm,
  },
  sectionLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 4,
  },
  sectionLabelText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textMuted,
    letterSpacing: 1,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 16,
    gap: 12,
  },
  menuIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.accentLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuIconDanger: { backgroundColor: '#FEF2F2' },
  menuLabel:      { flex: 1, fontSize: 15, fontWeight: '600', color: colors.text },
  menuLabelDanger:{ color: colors.danger },
  menuDivider:    { height: 1, backgroundColor: colors.border, marginLeft: 64 },
  timeoutValue: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.accent,
    marginRight: 4,
  },
});
