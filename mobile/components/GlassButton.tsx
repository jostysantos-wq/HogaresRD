import React from 'react';
import {
  TouchableOpacity, Text, StyleSheet, ViewStyle, TextStyle,
  ActivityIndicator, Platform, View,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, glass } from '@/constants/theme';

interface Props {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost';
  icon?: React.ComponentProps<typeof Ionicons>['name'];
  loading?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
  labelStyle?: TextStyle;
  size?: 'sm' | 'md' | 'lg';
}

export default function GlassButton({
  label, onPress, variant = 'primary', icon,
  loading, disabled, style, labelStyle, size = 'md',
}: Props) {
  const pad = size === 'sm' ? { px: 14, py: 9 } : size === 'lg' ? { px: 28, py: 17 } : { px: 20, py: 13 };
  const fontSize = size === 'sm' ? 13 : size === 'lg' ? 17 : 15;
  const iconSize = size === 'sm' ? 14 : size === 'lg' ? 20 : 17;

  if (variant === 'primary') {
    return (
      <TouchableOpacity
        onPress={onPress}
        disabled={disabled || loading}
        activeOpacity={0.8}
        style={[styles.base, styles.primaryBase, { paddingHorizontal: pad.px, paddingVertical: pad.py }, disabled && { opacity: 0.5 }, style]}
      >
        {/* Glass highlight streak at top */}
        <View style={styles.primaryHighlight} pointerEvents="none" />

        {loading
          ? <ActivityIndicator color="#fff" size="small" />
          : <>
              {icon && <Ionicons name={icon} size={iconSize} color="#fff" style={{ marginRight: 7 }} />}
              <Text style={[styles.primaryLabel, { fontSize }, labelStyle]}>{label}</Text>
            </>
        }
      </TouchableOpacity>
    );
  }

  if (variant === 'secondary') {
    return (
      <TouchableOpacity
        onPress={onPress}
        disabled={disabled || loading}
        activeOpacity={0.75}
        style={[styles.base, { paddingHorizontal: pad.px, paddingVertical: pad.py }, disabled && { opacity: 0.5 }, style]}
      >
        <BlurView intensity={glass.button} tint="light" style={StyleSheet.absoluteFill} />
        {/* Top highlight */}
        <View style={styles.secondaryHighlight} pointerEvents="none" />
        {/* Bottom shadow line */}
        <View style={styles.secondaryInnerShadow} pointerEvents="none" />

        {loading
          ? <ActivityIndicator color={colors.primary} size="small" />
          : <>
              {icon && <Ionicons name={icon} size={iconSize} color={colors.primary} style={{ marginRight: 7 }} />}
              <Text style={[styles.secondaryLabel, { fontSize }, labelStyle]}>{label}</Text>
            </>
        }
      </TouchableOpacity>
    );
  }

  // ghost
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.7}
      style={[styles.base, styles.ghostBase, { paddingHorizontal: pad.px, paddingVertical: pad.py }, disabled && { opacity: 0.5 }, style]}
    >
      <BlurView intensity={30} tint="light" style={StyleSheet.absoluteFill} />
      {loading
        ? <ActivityIndicator color={colors.textMuted} size="small" />
        : <>
            {icon && <Ionicons name={icon} size={iconSize} color={colors.textMuted} style={{ marginRight: 6 }} />}
            <Text style={[styles.ghostLabel, { fontSize }, labelStyle]}>{label}</Text>
          </>
      }
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.xl,
    overflow: 'hidden',
    position: 'relative',
    ...glass.shadow,
  },

  // ── Primary: deep navy glass ──────────────────────────────────
  primaryBase: {
    backgroundColor: glass.darkBg,
    borderWidth: 1,
    borderColor: glass.darkBorder,
    // Specular sheen via extra border on top via highlight view
  },
  primaryHighlight: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    height: '45%',
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  primaryLabel: {
    color: '#fff',
    fontWeight: '700',
    letterSpacing: 0.2,
  },

  // ── Secondary: frosted light glass ───────────────────────────
  secondaryHighlight: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    height: '40%',
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    backgroundColor: 'rgba(255,255,255,0.55)',
  },
  secondaryInnerShadow: {
    position: 'absolute',
    bottom: 0, left: 0, right: 0,
    height: 1,
    backgroundColor: 'rgba(0,45,98,0.15)',
  },
  secondaryLabel: {
    color: colors.primary,
    fontWeight: '700',
    letterSpacing: 0.2,
  },

  // ── Ghost: barely-there glass ─────────────────────────────────
  ghostBase: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  ghostLabel: {
    color: colors.textMuted,
    fontWeight: '600',
  },
});
