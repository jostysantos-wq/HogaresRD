import React, { useEffect, useState, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, Dimensions, FlatList, Modal, TextInput,
  KeyboardAvoidingView, Platform, Alert, Linking,
} from 'react-native';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, shadow, CONDITION_COLORS, TYPE_LABELS } from '@/constants/theme';
import { endpoints } from '@/constants/api';
import type { Listing } from '@/hooks/useListings';

const { width } = Dimensions.get('window');

function formatPrice(price: number, currency: string, condition: string) {
  if (!price) return 'Precio a consultar';
  const sym = currency === 'DOP' ? 'RD$' : '$';
  const fmt = new Intl.NumberFormat('es-DO').format(price);
  return `${sym}${fmt}${condition === 'alquiler' ? '/mes' : ''}`;
}

function slugify(name: string) {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

// ─── Photo Gallery ────────────────────────────────────────────────────────────
function Gallery({ images }: { images: string[] }) {
  const [idx, setIdx] = useState(0);
  const flatRef = useRef<FlatList>(null);

  if (!images.length) {
    return (
      <View style={gStyles.placeholder}>
        <Ionicons name="home-outline" size={56} color={colors.border} />
      </View>
    );
  }

  return (
    <View style={gStyles.container}>
      <FlatList
        ref={flatRef}
        data={images}
        horizontal pagingEnabled
        showsHorizontalScrollIndicator={false}
        keyExtractor={(_, i) => String(i)}
        onMomentumScrollEnd={e => {
          setIdx(Math.round(e.nativeEvent.contentOffset.x / width));
        }}
        renderItem={({ item }) => (
          <Image source={{ uri: item }} style={{ width, height: 280 }} contentFit="cover" />
        )}
      />
      {images.length > 1 && (
        <View style={gStyles.dots}>
          {images.map((_, i) => (
            <View key={i} style={[gStyles.dot, i === idx && gStyles.dotActive]} />
          ))}
        </View>
      )}
      <View style={gStyles.counter}>
        <Text style={gStyles.counterText}>{idx + 1} / {images.length}</Text>
      </View>
    </View>
  );
}

const gStyles = StyleSheet.create({
  container: { height: 280, position: 'relative', backgroundColor: '#EFF2F7' },
  placeholder: { height: 280, backgroundColor: '#EFF2F7', alignItems: 'center', justifyContent: 'center' },
  dots: { position: 'absolute', bottom: 12, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.5)' },
  dotActive: { backgroundColor: '#fff', width: 18 },
  counter: {
    position: 'absolute', bottom: 12, right: 12,
    backgroundColor: 'rgba(0,0,0,0.45)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10,
  },
  counterText: { color: '#fff', fontSize: 11, fontWeight: '600' },
});

// ─── Blueprint Gallery ────────────────────────────────────────────────────────
function BlueprintModal({ blueprints, visible, initialIndex, onClose }: {
  blueprints: string[]; visible: boolean; initialIndex: number; onClose: () => void;
}) {
  const [idx, setIdx] = useState(initialIndex);
  useEffect(() => setIdx(initialIndex), [initialIndex]);

  return (
    <Modal visible={visible} animationType="fade" statusBarTranslucent>
      <View style={bmStyles.container}>
        <TouchableOpacity style={bmStyles.closeBtn} onPress={onClose}>
          <Ionicons name="close" size={28} color="#fff" />
        </TouchableOpacity>
        <Text style={bmStyles.counter}>{idx + 1} / {blueprints.length}</Text>
        <Image source={{ uri: blueprints[idx] }} style={bmStyles.image} contentFit="contain" />
        <View style={bmStyles.nav}>
          <TouchableOpacity
            style={[bmStyles.navBtn, idx === 0 && { opacity: 0.3 }]}
            onPress={() => setIdx(i => Math.max(0, i - 1))}
            disabled={idx === 0}
          >
            <Ionicons name="chevron-back" size={28} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity
            style={[bmStyles.navBtn, idx === blueprints.length - 1 && { opacity: 0.3 }]}
            onPress={() => setIdx(i => Math.min(blueprints.length - 1, i + 1))}
            disabled={idx === blueprints.length - 1}
          >
            <Ionicons name="chevron-forward" size={28} color="#fff" />
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const bmStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  closeBtn: { position: 'absolute', top: 56, right: 20, zIndex: 10, padding: 8 },
  counter: { position: 'absolute', top: 60, left: 20, color: '#fff', fontSize: 14, fontWeight: '600' },
  image: { width: width, height: 400 },
  nav: { position: 'absolute', bottom: 60, flexDirection: 'row', gap: 32 },
  navBtn: { padding: 12 },
});

// ─── Inquiry Modal ────────────────────────────────────────────────────────────
function InquiryModal({ listing, visible, onClose }: { listing: Listing; visible: boolean; onClose: () => void }) {
  const [name, setName]       = useState('');
  const [phone, setPhone]     = useState('');
  const [email, setEmail]     = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    if (!name.trim() || !phone.trim() || !email.trim()) {
      Alert.alert('Campos requeridos', 'Nombre, teléfono y correo son obligatorios.');
      return;
    }
    setSending(true);
    try {
      const res = await fetch(endpoints.inquiry(listing.id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, phone, email, message }),
      });
      if (res.ok) {
        Alert.alert('¡Enviado!', 'Tu consulta fue enviada a la inmobiliaria. Te contactarán pronto.');
        setName(''); setPhone(''); setEmail(''); setMessage('');
        onClose();
      } else {
        Alert.alert('Error', 'No se pudo enviar la consulta. Intenta de nuevo.');
      }
    } catch {
      Alert.alert('Error de conexión', 'Verifica tu conexión e intenta de nuevo.');
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={iqStyles.header}>
          <Text style={iqStyles.headerTitle}>Enviar consulta</Text>
          <TouchableOpacity onPress={onClose} hitSlop={12}>
            <Ionicons name="close" size={24} color={colors.text} />
          </TouchableOpacity>
        </View>
        <View style={iqStyles.listingRow}>
          <Text style={iqStyles.listingTitle} numberOfLines={2}>{listing.title}</Text>
        </View>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={iqStyles.form}>
          {[
            { label: 'Nombre completo *', val: name,    set: setName,    key: 'name',  ph: 'Tu nombre' },
            { label: 'Teléfono *',        val: phone,   set: setPhone,   key: 'phone', ph: '+1 (809) 000-0000' },
            { label: 'Correo electrónico *', val: email, set: setEmail, key: 'email', ph: 'tu@correo.com' },
          ].map(f => (
            <View key={f.key} style={iqStyles.field}>
              <Text style={iqStyles.label}>{f.label}</Text>
              <TextInput
                style={iqStyles.input}
                value={f.val}
                onChangeText={f.set}
                placeholder={f.ph}
                placeholderTextColor={colors.textLight}
                keyboardType={f.key === 'email' ? 'email-address' : f.key === 'phone' ? 'phone-pad' : 'default'}
                autoCapitalize={f.key === 'email' ? 'none' : 'words'}
              />
            </View>
          ))}
          <View style={iqStyles.field}>
            <Text style={iqStyles.label}>Mensaje (opcional)</Text>
            <TextInput
              style={[iqStyles.input, { height: 100, textAlignVertical: 'top' }]}
              value={message}
              onChangeText={setMessage}
              placeholder="¿Algo más que quieras saber?"
              placeholderTextColor={colors.textLight}
              multiline
            />
          </View>
          <TouchableOpacity style={iqStyles.sendBtn} onPress={handleSend} disabled={sending}>
            {sending
              ? <ActivityIndicator color="#fff" />
              : <Text style={iqStyles.sendText}>Enviar consulta</Text>
            }
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const iqStyles = StyleSheet.create({
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    padding: 20, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  headerTitle: { fontSize: 18, fontWeight: '700', color: colors.text },
  listingRow: { paddingHorizontal: 20, paddingVertical: 12, backgroundColor: colors.bg, borderBottomWidth: 1, borderBottomColor: colors.border },
  listingTitle: { fontSize: 14, color: colors.textMuted, fontWeight: '500' },
  form: { padding: 20, gap: 16, paddingBottom: 40 },
  field: { gap: 6 },
  label: { fontSize: 13, fontWeight: '600', color: colors.textMuted },
  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    padding: 12, fontSize: 15, color: colors.text, backgroundColor: colors.surface,
  },
  sendBtn: {
    backgroundColor: colors.primary, borderRadius: radius.md,
    paddingVertical: 15, alignItems: 'center', marginTop: 8,
  },
  sendText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function ListingScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router  = useRouter();
  const insets  = useSafeAreaInsets();
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(false);
  const [showInquiry,  setShowInquiry]  = useState(false);
  const [showBp,       setShowBp]       = useState(false);
  const [bpIndex,      setBpIndex]      = useState(0);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    fetch(endpoints.listing(id))
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(setListing)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return (
    <View style={styles.center}>
      <ActivityIndicator size="large" color={colors.primary} />
    </View>
  );

  if (error || !listing) return (
    <View style={styles.center}>
      <Ionicons name="alert-circle-outline" size={48} color={colors.textMuted} />
      <Text style={styles.errText}>Propiedad no encontrada</Text>
      <TouchableOpacity onPress={() => router.back()}>
        <Text style={styles.backLink}>Volver</Text>
      </TouchableOpacity>
    </View>
  );

  const operation  = ['venta','alquiler','nueva_construccion','planos'].includes(listing.type)
    ? listing.type : listing.condition;
  const condColor  = CONDITION_COLORS[operation] || colors.primary;
  const condLabel  = operation === 'alquiler' ? 'Alquiler'
    : operation === 'nueva_construccion' ? 'Nueva Construcción'
    : operation === 'planos' ? 'En Planos' : 'Venta';
  const blueprints = (listing.blueprints || []).filter(Boolean);
  const agencies   = listing.agencies || [];

  return (
    <>
      <Stack.Screen options={{ title: listing.title, headerStyle: { backgroundColor: colors.primary }, headerTintColor: '#fff' }} />
      <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>
        <Gallery images={listing.images || []} />

        <View style={styles.body}>
          {/* Badges */}
          <View style={styles.badges}>
            <View style={[styles.badge, { backgroundColor: condColor }]}>
              <Text style={styles.badgeText}>{condLabel}</Text>
            </View>
            {listing.type && !['venta','alquiler','nueva_construccion','planos'].includes(listing.type) && (
              <View style={[styles.badge, { backgroundColor: colors.tag }]}>
                <Text style={[styles.badgeText, { color: colors.tagText }]}>
                  {TYPE_LABELS[listing.type] || listing.type}
                </Text>
              </View>
            )}
          </View>

          {/* Price & title */}
          <Text style={styles.price}>{formatPrice(listing.price, listing.currency, listing.condition)}</Text>
          <Text style={styles.title}>{listing.title}</Text>

          {/* Location */}
          <View style={styles.locRow}>
            <Ionicons name="location-outline" size={14} color={colors.textMuted} />
            <Text style={styles.locText}>
              {[listing.address, listing.city, listing.province].filter(Boolean).join(', ')}
            </Text>
          </View>

          {/* Specs */}
          {(listing.bedrooms || listing.bathrooms || listing.area || listing.units_total) ? (
            <View style={styles.specsRow}>
              {listing.bedrooms     ? <SpecPill icon="bed-outline"    label={`${listing.bedrooms} hab.`} /> : null}
              {listing.bathrooms    ? <SpecPill icon="water-outline"  label={`${listing.bathrooms} baños`} /> : null}
              {listing.area         ? <SpecPill icon="expand-outline" label={`${listing.area} m²`} /> : null}
              {listing.units_total  ? <SpecPill icon="business-outline" label={`${listing.units_available || '?'} / ${listing.units_total} unid.`} /> : null}
            </View>
          ) : null}

          <View style={styles.divider} />

          {/* Description */}
          <Text style={styles.sectionTitle}>Descripción</Text>
          <Text style={styles.description}>{listing.description}</Text>

          {/* Tags */}
          {listing.tags?.length ? (
            <>
              <View style={styles.divider} />
              <Text style={styles.sectionTitle}>Características</Text>
              <View style={styles.tagWrap}>
                {listing.tags.map(t => (
                  <View key={t} style={styles.tag}>
                    <Ionicons name="checkmark-circle" size={13} color={colors.accent} />
                    <Text style={styles.tagText}>{t}</Text>
                  </View>
                ))}
              </View>
            </>
          ) : null}

          {/* Unit types */}
          {listing.unit_types?.length ? (
            <>
              <View style={styles.divider} />
              <Text style={styles.sectionTitle}>Tipos de unidad</Text>
              {listing.unit_types.map((ut, i) => (
                <View key={i} style={styles.unitRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.unitName}>{ut.name}</Text>
                    <Text style={styles.unitMeta}>
                      {ut.bedrooms} hab · {ut.bathrooms} baños · {ut.area} m²
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={styles.unitPrice}>
                      ${new Intl.NumberFormat('es-DO').format(ut.price)}
                    </Text>
                    <Text style={styles.unitAvail}>{ut.available}/{ut.total} dispon.</Text>
                  </View>
                </View>
              ))}
            </>
          ) : null}

          {/* Blueprints */}
          {blueprints.length ? (
            <>
              <View style={styles.divider} />
              <Text style={styles.sectionTitle}>Planos</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.bpScroll}>
                {blueprints.map((bp, i) => (
                  <TouchableOpacity key={i} style={styles.bpThumb} onPress={() => { setBpIndex(i); setShowBp(true); }}>
                    <Image source={{ uri: bp }} style={styles.bpImg} contentFit="cover" />
                    <View style={styles.bpOverlay}>
                      <Ionicons name="expand-outline" size={18} color="#fff" />
                    </View>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </>
          ) : null}

          {/* Agencies */}
          {agencies.length ? (
            <>
              <View style={styles.divider} />
              <Text style={styles.sectionTitle}>Inmobiliarias</Text>
              {agencies.map((a, i) => (
                <TouchableOpacity
                  key={i}
                  style={styles.agencyRow}
                  onPress={() => a.name && router.push(`/inmobiliaria/${slugify(a.name)}`)}
                >
                  <View style={styles.agencyAvatar}>
                    <Text style={styles.agencyInitial}>
                      {a.name?.charAt(0).toUpperCase() || '?'}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.agencyName}>{a.name}</Text>
                    {a.phone && <Text style={styles.agencyMeta}>{a.phone}</Text>}
                  </View>
                  {a.phone && (
                    <TouchableOpacity
                      style={styles.callBtn}
                      onPress={() => Linking.openURL(`tel:${a.phone}`)}
                    >
                      <Ionicons name="call-outline" size={16} color={colors.primary} />
                    </TouchableOpacity>
                  )}
                  <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
                </TouchableOpacity>
              ))}
            </>
          ) : null}

          {listing.construction_company ? (
            <View style={styles.constructoraRow}>
              <Ionicons name="construct-outline" size={14} color={colors.textMuted} />
              <Text style={styles.constructoraText}>
                Constructora:{' '}
                {typeof listing.construction_company === 'object'
                  ? (listing.construction_company as any).name
                  : listing.construction_company}
              </Text>
            </View>
          ) : null}

          <View style={{ height: 100 }} />
        </View>
      </ScrollView>

      {/* Sticky CTA */}
      <View style={[styles.cta, { paddingBottom: insets.bottom + 12 }]}>
        <TouchableOpacity style={styles.ctaBtn} onPress={() => setShowInquiry(true)}>
          <Ionicons name="mail-outline" size={18} color="#fff" />
          <Text style={styles.ctaBtnText}>Solicitar información</Text>
        </TouchableOpacity>
        {agencies[0]?.phone && (
          <TouchableOpacity
            style={styles.callCta}
            onPress={() => Linking.openURL(`tel:${agencies[0].phone}`)}
          >
            <Ionicons name="call" size={20} color={colors.primary} />
          </TouchableOpacity>
        )}
      </View>

      <InquiryModal listing={listing} visible={showInquiry} onClose={() => setShowInquiry(false)} />
      <BlueprintModal blueprints={blueprints} visible={showBp} initialIndex={bpIndex} onClose={() => setShowBp(false)} />
    </>
  );
}

function SpecPill({ icon, label }: { icon: string; label: string }) {
  return (
    <View style={styles.specPill}>
      <Ionicons name={icon as any} size={14} color={colors.primary} />
      <Text style={styles.specLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  errText: { fontSize: 16, color: colors.textMuted },
  backLink: { fontSize: 15, color: colors.accent, fontWeight: '600' },
  body: { padding: 20, gap: 8 },
  badges: { flexDirection: 'row', gap: 8, marginBottom: 4 },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.sm },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  price: { fontSize: 26, fontWeight: '900', color: colors.primary },
  title: { fontSize: 18, fontWeight: '700', color: colors.text, lineHeight: 24 },
  locRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 5, marginTop: 4 },
  locText: { fontSize: 13, color: colors.textMuted, flex: 1, lineHeight: 18 },
  specsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  specPill: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: colors.accentLight, paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 20,
  },
  specLabel: { fontSize: 12, fontWeight: '600', color: colors.primary },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: 16 },
  sectionTitle: { fontSize: 15, fontWeight: '800', color: colors.text, marginBottom: 10 },
  description: { fontSize: 14, color: colors.textMuted, lineHeight: 22 },
  tagWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tag: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 10, paddingVertical: 5,
    backgroundColor: colors.tag, borderRadius: 20,
  },
  tagText: { fontSize: 12, color: colors.tagText, fontWeight: '500' },
  unitRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  unitName: { fontSize: 14, fontWeight: '700', color: colors.text },
  unitMeta: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  unitPrice: { fontSize: 14, fontWeight: '800', color: colors.primary },
  unitAvail: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  bpScroll: { marginHorizontal: -20, paddingLeft: 20 },
  bpThumb: { width: 140, height: 100, borderRadius: radius.md, overflow: 'hidden', marginRight: 10, position: 'relative' },
  bpImg: { width: '100%', height: '100%' },
  bpOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.25)', alignItems: 'center', justifyContent: 'center',
  },
  agencyRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  agencyAvatar: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: colors.accentLight, alignItems: 'center', justifyContent: 'center',
  },
  agencyInitial: { fontSize: 18, fontWeight: '800', color: colors.primary },
  agencyName: { fontSize: 14, fontWeight: '700', color: colors.text },
  agencyMeta: { fontSize: 12, color: colors.textMuted },
  callBtn: {
    width: 36, height: 36, borderRadius: 18,
    borderWidth: 1.5, borderColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  constructoraRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border,
  },
  constructoraText: { fontSize: 13, color: colors.textMuted },
  cta: {
    flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingTop: 12,
    backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border,
  },
  ctaBtn: {
    flex: 1, backgroundColor: colors.primary, borderRadius: radius.md,
    paddingVertical: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  ctaBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  callCta: {
    width: 52, height: 52, borderRadius: radius.md,
    borderWidth: 1.5, borderColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surface,
  },
});
