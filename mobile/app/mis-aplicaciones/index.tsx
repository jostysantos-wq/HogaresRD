import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, shadow } from '@/constants/theme';
import { endpoints } from '@/constants/api';
import { useAuth } from '@/hooks/useAuth';

// ── Types ─────────────────────────────────────────────────────────────────

interface Application {
  id:             string;
  listing_id:     string;
  listing_title:  string;
  listing_price:  string | number;
  listing_type:   string;
  status:         string;
  status_reason?: string;
  intent:         string;
  created_at:     string;
  updated_at:     string;
  timeline_events?: { type: string; description: string; created_at: string }[];
}

// ── Status config ─────────────────────────────────────────────────────────

const STATUS: Record<string, { label: string; color: string; icon: string; bg: string }> = {
  aplicado:  { label: 'Recibida',    color: '#2563EB', icon: 'time-outline',          bg: '#EFF6FF' },
  revisando: { label: 'En revisión', color: '#D97706', icon: 'search-outline',         bg: '#FFFBEB' },
  aprobado:  { label: 'Aprobada',    color: '#16A34A', icon: 'checkmark-circle-outline', bg: '#F0FDF4' },
  rechazado: { label: 'Rechazada',   color: '#DC2626', icon: 'close-circle-outline',   bg: '#FEF2F2' },
  cerrado:   { label: 'Cerrada',     color: '#6B7280', icon: 'archive-outline',         bg: '#F9FAFB' },
};

function formatPrice(p: string | number) {
  const n = Number(p);
  if (!n) return 'Precio a consultar';
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return '$' + (n / 1_000).toFixed(0) + 'K';
  return '$' + n.toLocaleString('es-DO');
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const d = Math.floor(diff / 86400000);
  if (d === 0) return 'Hoy';
  if (d === 1) return 'Ayer';
  if (d < 30)  return `Hace ${d} días`;
  const m = Math.floor(d / 30);
  return `Hace ${m} mes${m > 1 ? 'es' : ''}`;
}

// ── Application card ──────────────────────────────────────────────────────

function AppCard({ app, onPress }: { app: Application; onPress: () => void }) {
  const st = STATUS[app.status] || STATUS.aplicado;

  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.82}>
      {/* Status pill */}
      <View style={[styles.statusPill, { backgroundColor: st.bg }]}>
        <Ionicons name={st.icon as any} size={13} color={st.color} />
        <Text style={[styles.statusText, { color: st.color }]}>{st.label}</Text>
      </View>

      {/* Title + price */}
      <Text style={styles.title} numberOfLines={2}>{app.listing_title}</Text>
      <Text style={styles.price}>{formatPrice(app.listing_price)}</Text>

      {/* Meta row */}
      <View style={styles.metaRow}>
        <View style={styles.metaItem}>
          <Ionicons name="calendar-outline" size={12} color={colors.textMuted} />
          <Text style={styles.metaText}>{timeAgo(app.created_at)}</Text>
        </View>
        <View style={styles.metaItem}>
          <Ionicons name="flag-outline" size={12} color={colors.textMuted} />
          <Text style={styles.metaText}>
            {app.intent === 'comprar' ? 'Comprar' : app.intent === 'alquilar' ? 'Alquilar' : app.intent}
          </Text>
        </View>
      </View>

      <Ionicons name="chevron-forward" size={16} color={colors.textMuted} style={styles.chevron} />
    </TouchableOpacity>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────

export default function MisAplicacionesScreen() {
  const router  = useRouter();
  const insets  = useSafeAreaInsets();
  const { user, authHeaders } = useAuth();

  const [apps,      setApps]      = useState<Application[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [refreshing,setRefreshing]= useState(false);
  const [error,     setError]     = useState('');

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const res  = await fetch(endpoints.applications, { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Error al cargar');
      setApps(data.applications || data || []);
    } catch (e: any) {
      setError(e.message || 'No se pudo cargar.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [authHeaders]);

  useEffect(() => { load(); }, [load]);

  // ── Not logged in ───────────────────────────────────────────────────────
  if (!user) {
    return (
      <>
        <Stack.Screen options={{ title: 'Mis Aplicaciones', headerShown: true }} />
        <View style={styles.center}>
          <Ionicons name="lock-closed-outline" size={52} color={colors.border} />
          <Text style={styles.emptyTitle}>Inicia sesión</Text>
          <Text style={styles.emptyText}>Necesitas una cuenta para ver tus aplicaciones.</Text>
          <TouchableOpacity style={styles.loginBtn} onPress={() => router.push('/auth/login')}>
            <Text style={styles.loginBtnText}>Iniciar sesión</Text>
          </TouchableOpacity>
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Mis Aplicaciones', headerShown: true }} />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Ionicons name="alert-circle-outline" size={48} color={colors.textMuted} />
          <Text style={styles.emptyText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={() => load()}>
            <Text style={styles.retryText}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      ) : apps.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="document-text-outline" size={56} color={colors.border} />
          <Text style={styles.emptyTitle}>Sin aplicaciones</Text>
          <Text style={styles.emptyText}>
            Cuando apliques a una propiedad, aparecerá aquí con su estado actualizado.
          </Text>
          <TouchableOpacity style={styles.loginBtn} onPress={() => router.push('/(tabs)/')}>
            <Text style={styles.loginBtnText}>Explorar propiedades</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={apps}
          keyExtractor={a => a.id}
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 24 }]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(true); }}
              tintColor={colors.primary}
            />
          }
          ListHeaderComponent={
            <Text style={styles.count}>{apps.length} aplicación{apps.length !== 1 ? 'es' : ''}</Text>
          }
          renderItem={({ item }) => (
            <AppCard
              app={item}
              onPress={() => router.push(`/mis-aplicaciones/${item.id}` as any)}
            />
          )}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    padding: 32, gap: 12, backgroundColor: colors.bg,
  },
  emptyTitle: { fontSize: 20, fontWeight: '800', color: colors.primary, textAlign: 'center' },
  emptyText:  { fontSize: 14, color: colors.textMuted, textAlign: 'center', lineHeight: 20 },
  loginBtn: {
    marginTop: 8, backgroundColor: colors.primary,
    paddingHorizontal: 28, paddingVertical: 13,
    borderRadius: radius.md, ...shadow.sm,
  },
  loginBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  retryBtn: {
    marginTop: 8, borderWidth: 1.5, borderColor: colors.primary,
    paddingHorizontal: 24, paddingVertical: 11, borderRadius: radius.md,
  },
  retryText: { color: colors.primary, fontSize: 14, fontWeight: '600' },

  list:  { padding: 16, gap: 12 },
  count: { fontSize: 13, color: colors.textMuted, marginBottom: 4 },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: 16,
    ...shadow.sm,
    position: 'relative',
  },
  statusPill: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 20, marginBottom: 10,
  },
  statusText: { fontSize: 12, fontWeight: '700' },
  title: { fontSize: 15, fontWeight: '700', color: colors.text, lineHeight: 20, marginBottom: 4, paddingRight: 20 },
  price: { fontSize: 18, fontWeight: '900', color: colors.primary, marginBottom: 10 },
  metaRow: { flexDirection: 'row', gap: 16 },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaText: { fontSize: 12, color: colors.textMuted },
  chevron: { position: 'absolute', right: 16, top: '50%' },
});
