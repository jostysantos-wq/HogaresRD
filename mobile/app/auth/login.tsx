import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, ActivityIndicator, KeyboardAvoidingView,
  Platform, ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, shadow } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { useBiometric } from '@/hooks/useBiometric';

export default function LoginScreen() {
  const router = useRouter();
  const { login, loginWithBiometric } = useAuth();
  const { isEnabled, biometricType, authenticate, loading: bioLoading } = useBiometric();

  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [showPw,   setShowPw]   = useState(false);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState('');
  const [bioAttempted, setBioAttempted] = useState(false);

  // Auto-trigger biometric login on mount if enrolled
  useEffect(() => {
    if (isEnabled && !bioLoading && !bioAttempted) {
      setBioAttempted(true);
      handleBiometricLogin();
    }
  }, [isEnabled, bioLoading]);

  async function handleBiometricLogin() {
    setError('');
    setLoading(true);
    try {
      const result = await authenticate();
      await loginWithBiometric(result.token, result.user);
      router.replace('/(tabs)/cuenta');
    } catch (e: any) {
      // Silent fail on auto-trigger — user can still type password
      if (bioAttempted) {
        setError(e.message || 'Error con biometrico');
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleLogin() {
    if (!email.trim() || !password) {
      setError('Completa todos los campos.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      await login(email.trim().toLowerCase(), password);
      router.replace('/(tabs)/cuenta');
    } catch (e: any) {
      setError(e.message || 'Error al iniciar sesion.');
    } finally {
      setLoading(false);
    }
  }

  const bioIcon = biometricType === 'Face ID' ? 'scan-outline' : 'finger-print-outline';

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        {/* Card */}
        <View style={styles.card}>
          <Text style={styles.heading}>Iniciar sesion</Text>
          <Text style={styles.sub}>Bienvenido de nuevo a HogaresRD</Text>

          {/* Biometric quick-login button */}
          {isEnabled && !bioLoading && (
            <>
              <TouchableOpacity
                style={styles.bioBtn}
                onPress={handleBiometricLogin}
                disabled={loading}
                activeOpacity={0.7}
              >
                <View style={styles.bioBtnIcon}>
                  <Ionicons name={bioIcon as any} size={32} color={colors.primary} />
                </View>
                <Text style={styles.bioBtnText}>
                  Iniciar con {biometricType}
                </Text>
              </TouchableOpacity>

              <View style={styles.divider}>
                <View style={styles.divLine} />
                <Text style={styles.divText}>o usa tu contrasena</Text>
                <View style={styles.divLine} />
              </View>
            </>
          )}

          {/* Email */}
          <View style={styles.fieldWrap}>
            <Text style={styles.label}>Correo electronico</Text>
            <View style={styles.inputRow}>
              <Ionicons name="mail-outline" size={18} color={colors.textMuted} style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder="tu@correo.com"
                placeholderTextColor={colors.textLight}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                value={email}
                onChangeText={setEmail}
              />
            </View>
          </View>

          {/* Password */}
          <View style={styles.fieldWrap}>
            <Text style={styles.label}>Contrasena</Text>
            <View style={styles.inputRow}>
              <Ionicons name="lock-closed-outline" size={18} color={colors.textMuted} style={styles.inputIcon} />
              <TextInput
                style={[styles.input, { flex: 1 }]}
                placeholder="••••••••"
                placeholderTextColor={colors.textLight}
                secureTextEntry={!showPw}
                value={password}
                onChangeText={setPassword}
                onSubmitEditing={handleLogin}
              />
              <TouchableOpacity onPress={() => setShowPw(v => !v)} style={styles.eyeBtn}>
                <Ionicons
                  name={showPw ? 'eye-off-outline' : 'eye-outline'}
                  size={18}
                  color={colors.textMuted}
                />
              </TouchableOpacity>
            </View>
          </View>

          {/* Error */}
          {error ? (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle-outline" size={15} color={colors.danger} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          {/* Submit */}
          <TouchableOpacity
            style={[styles.btn, loading && styles.btnDisabled]}
            onPress={handleLogin}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.btnText}>Iniciar sesion</Text>
            }
          </TouchableOpacity>

          {/* Divider */}
          <View style={styles.divider}>
            <View style={styles.divLine} />
            <Text style={styles.divText}>No tienes cuenta?</Text>
            <View style={styles.divLine} />
          </View>

          {/* Register link */}
          <TouchableOpacity
            style={styles.outlineBtn}
            onPress={() => router.push('/auth/register')}
            activeOpacity={0.85}
          >
            <Text style={styles.outlineBtnText}>Crear cuenta gratis</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 20,
    paddingBottom: 40,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: 24,
    ...shadow.md,
  },
  heading: {
    fontSize: 24,
    fontWeight: '900',
    color: colors.primary,
    marginBottom: 4,
  },
  sub: {
    fontSize: 14,
    color: colors.textMuted,
    marginBottom: 28,
  },
  // Biometric button
  bioBtn: {
    alignItems: 'center',
    paddingVertical: 20,
    marginBottom: 4,
  },
  bioBtnIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.accentLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
    borderWidth: 2,
    borderColor: colors.accent + '30',
  },
  bioBtnText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.primary,
  },
  // Fields
  fieldWrap: { marginBottom: 16 },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 6,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
    paddingHorizontal: 12,
    height: 48,
  },
  inputIcon: { marginRight: 8 },
  input: {
    flex: 1,
    fontSize: 15,
    color: colors.text,
  },
  eyeBtn: { padding: 4 },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#FEF2F2',
    borderRadius: radius.sm,
    padding: 10,
    marginBottom: 12,
  },
  errorText: { fontSize: 13, color: colors.danger, flex: 1 },
  btn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    height: 50,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginVertical: 20,
  },
  divLine: { flex: 1, height: 1, backgroundColor: colors.border },
  divText: { fontSize: 13, color: colors.textMuted },
  outlineBtn: {
    borderWidth: 1.5,
    borderColor: colors.primary,
    borderRadius: radius.md,
    height: 50,
    alignItems: 'center',
    justifyContent: 'center',
  },
  outlineBtnText: { color: colors.primary, fontSize: 15, fontWeight: '700' },
});
