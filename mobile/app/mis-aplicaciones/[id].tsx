import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView,
  ActivityIndicator, TouchableOpacity,
} from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, shadow } from '@/constants/theme';
import { endpoints } from '@/constants/api';
import { useAuth } from '@/hooks/useAuth';

interface TimelineEvent {
  type:        string;
  description: string;
  created_at:  string;
}

interface Application {
  id:              string;
  listing_id:      string;
  listing_title:   string;
  listing_price:   string | number;
  listing_type:    string;
  status:          string;
  status_reason?:  string;
  intent:          string;
  financing:       string;
  budget:          string | number;
  timeline:        string;
  contact_method:  string;
  notes:           string;
  created_at:      string;
  updated_at:      string;
  timeline_events: TimelineEvent[];
}

const STATUS: Record<string, { label: string; color: string; icon: string; bg: string }> = {
  aplicado:      { label: 'Solicitud Recibida', color: '#2563EB', icon: 'time-outline',               bg: '#EFF6FF' },
  en_revision:   { label: 'En Revisión',        color: '#D97706', icon: 'search-outline',              bg: '#FFFBEB' },
  documentos:    { label: 'Documentos Pend.',   color: '#7C3AED', icon: 'document-text-outline',       bg: '#F5F3FF' },
  en_aprobacion: { label: 'En Aprobación',      color: '#0891B2', icon: 'shield-checkmark-outline',    bg: '#ECFEFF' },
  aprobado:      { label: 'Aprobada',           color: '#16A34A', icon: 'checkmark-circle-outline',    bg: '#F0FDF4' },
  completado:    { label: 'Completada',         color: '#16A34A', icon: 'trophy-outline',              bg: '#F0FDF4' },
  rechazado:     { label: 'Rechazada',          color: '#DC2626', icon: 'close-circle-outline',        bg: '#FEF2F2' },
};

const INTENT_LABELS:   Record<string, string> = { comprar: 'Compra', alquilar: 'Alquiler', invertir: 'Inversión' };
const FINANCE_LABELS:  Record<string, string> = { efectivo: 'Efectivo', banco: 'Financiamiento Bancario', desarrollador: 'Financiamiento Desarrollador' };
const TIMELINE_LABELS: Record<string, string> = { inmediato: 'Inmediato', '1_3_meses': '1–3 meses', '3_6_meses': '3–6 meses', 'mas_6_meses': 'Más de 6 meses' };
const CONTACT_LABELS:  Record<string, string> = { whatsapp: 'WhatsApp', llamada: 'Llamada', email: 'Email' };

function formatPrice(p: string | number) {
  const n = Number(p);
  if (!n) return 'A consultar';
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return '$' + (n / 1_000).toFixed(0) + 'K';
  return '$' + n.toLocaleString('es-DO');
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('es-DO', { day: '2-digit', month: 'long', year: 'numeric' });
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

export default function ApplicationDetailScreen() {
  const { id }   = useLocalSearchParams<{ id: string }>();
  const insets   = useSafeAreaInsets();
  const router   = useRouter();
  const { authHeaders } = useAuth();
  const [app,     setApp]     = useState<Application | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  useEffect(() => {
    fetch(endpoints.application(id), { headers: authHeaders() })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => setApp(data.application || data))
      .catch(() => setError('No se pudo cargar la solicitud.'))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Solicitud' }} />
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (error || !app) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: 'Solicitud' }} />
        <Ionicons name="alert-circle-outline" size={48} color={colors.danger} />
        <Text style={styles.errorText}>{error || 'Solicitud no encontrada'}</Text>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Text style={styles.backBtnText}>Volver</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const st = STATUS[app.status] || STATUS.aplicado;
  const events = Array.isArray(app.timeline_events) ? app.timeline_events : [];

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
      showsVerticalScrollIndicator={false}
    >
      <Stack.Screen options={{ title: 'Detalle de Solicitud' }} />

      {/* Status header */}
      <View style={[styles.statusHeader, { backgroundColor: st.bg }]}>
        <View style={[styles.statusIconWrap, { backgroundColor: st.color + '22' }]}>
          <Ionicons name={st.icon as any} size={28} color={st.color} />
        </View>
        <Text style={[styles.statusLabel, { color: st.color }]}>{st.label}</Text>
        {app.status_reason ? (
          <Text style={styles.statusReason}>{app.status_reason}</Text>
        ) : null}
      </View>

      {/* Property */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Propiedad</Text>
        <Text style={styles.listingTitle}>{app.listing_title}</Text>
        <Text style={styles.listingPrice}>{formatPrice(app.listing_price)}</Text>
        <TouchableOpacity
          style={styles.viewBtn}
          onPress={() => router.push(`/listing/${app.listing_id}`)}
        >
          <Text style={styles.viewBtnText}>Ver propiedad →</Text>
        </TouchableOpacity>
      </View>

      {/* Details */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Detalles de la Solicitud</Text>
        <InfoRow label="Intención"     value={INTENT_LABELS[app.intent]    || app.intent    || '—'} />
        <InfoRow label="Financiamiento" value={FINANCE_LABELS[app.financing] || app.financing || '—'} />
        <InfoRow label="Plazo"          value={TIMELINE_LABELS[app.timeline] || app.timeline  || '—'} />
        <InfoRow label="Contacto prefer." value={CONTACT_LABELS[app.contact_method] || app.contact_method || '—'} />
        {app.budget ? <InfoRow label="Presupuesto" value={formatPrice(app.budget)} /> : null}
        {app.notes  ? <InfoRow label="Notas"       value={app.notes} /> : null}
        <InfoRow label="Enviada"   value={formatDate(app.created_at)} />
        <InfoRow label="Actualizada" value={formatDate(app.updated_at)} />
      </View>

      {/* Timeline */}
      {events.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Historial</Text>
          {events.map((e, i) => (
            <View key={i} style={styles.timelineRow}>
              <View style={styles.timelineDot} />
              <View style={styles.timelineContent}>
                <Text style={styles.timelineDesc}>{e.description}</Text>
                <Text style={styles.timelineDate}>{formatDate(e.created_at)}</Text>
              </View>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  statusHeader: {
    alignItems: 'center', paddingVertical: 32, paddingHorizontal: 24,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  statusIconWrap: {
    width: 64, height: 64, borderRadius: 32,
    alignItems: 'center', justifyContent: 'center', marginBottom: 12,
  },
  statusLabel:  { fontSize: 20, fontWeight: '800', marginBottom: 6 },
  statusReason: { fontSize: 14, color: colors.textMuted, textAlign: 'center', lineHeight: 20 },
  card: {
    backgroundColor: colors.surface, borderRadius: radius.lg,
    marginHorizontal: 16, marginTop: 16, padding: 20, ...shadow.sm,
  },
  cardTitle: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, color: colors.textMuted, marginBottom: 14 },
  listingTitle: { fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: 4 },
  listingPrice: { fontSize: 20, fontWeight: '900', color: colors.primary, marginBottom: 14 },
  viewBtn: {
    backgroundColor: colors.accentLight, borderRadius: radius.md,
    paddingVertical: 10, alignItems: 'center',
  },
  viewBtnText: { color: colors.accent, fontWeight: '700', fontSize: 14 },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: colors.border },
  infoLabel: { fontSize: 14, color: colors.textMuted },
  infoValue: { fontSize: 14, fontWeight: '600', color: colors.text, flex: 1, textAlign: 'right' },
  timelineRow: { flexDirection: 'row', gap: 12, marginBottom: 16 },
  timelineDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent, marginTop: 5 },
  timelineContent: { flex: 1 },
  timelineDesc: { fontSize: 14, color: colors.text, lineHeight: 20, marginBottom: 3 },
  timelineDate: { fontSize: 12, color: colors.textMuted },
  errorText: { fontSize: 16, color: colors.textMuted, textAlign: 'center', marginTop: 12, marginBottom: 24 },
  backBtn: { backgroundColor: colors.primary, paddingHorizontal: 28, paddingVertical: 12, borderRadius: radius.md },
  backBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
