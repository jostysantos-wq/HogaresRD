import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  FlatList, ActivityIndicator, Dimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, shadow } from '@/constants/theme';
import { endpoints } from '@/constants/api';
import type { Listing } from '@/hooks/useListings';
import LogoMark from '@/components/LogoMark';

const { width } = Dimensions.get('window');

function formatPrice(price: number, currency: string, condition: string) {
  if (!price) return 'A consultar';
  const sym = currency === 'DOP' ? 'RD$' : '$';
  const fmt = new Intl.NumberFormat('es-DO').format(price);
  return `${sym}${fmt}${condition === 'alquiler' ? '/mes' : ''}`;
}

function TrendingCard({ listing }: { listing: Listing }) {
  const router = useRouter();
  const condColor = listing.condition === 'alquiler' ? '#065F46'
    : listing.condition === 'nueva_construccion' ? '#7C3AED'
    : '#002D62';
  const condLabel = listing.condition === 'alquiler' ? 'Alquiler'
    : listing.condition === 'nueva_construccion' ? 'Nueva Constr.'
    : listing.condition === 'planos' ? 'En Planos' : 'Venta';

  return (
    <TouchableOpacity
      style={tStyles.card}
      activeOpacity={0.92}
      onPress={() => router.push(`/listing/${listing.id}`)}
    >
      <View style={tStyles.imageWrap}>
        {listing.images?.[0] ? (
          <Image source={{ uri: listing.images[0] }} style={tStyles.image} contentFit="cover" />
        ) : (
          <View style={[tStyles.image, { backgroundColor: '#EFF2F7', alignItems: 'center', justifyContent: 'center' }]}>
            <Ionicons name="home-outline" size={28} color={colors.border} />
          </View>
        )}
        <View style={[tStyles.badge, { backgroundColor: condColor }]}>
          <Text style={tStyles.badgeText}>{condLabel}</Text>
        </View>
      </View>
      <View style={tStyles.body}>
        <Text style={tStyles.price}>{formatPrice(listing.price, listing.currency, listing.condition)}</Text>
        <Text style={tStyles.title} numberOfLines={2}>{listing.title}</Text>
        <View style={tStyles.loc}>
          <Ionicons name="location-outline" size={11} color={colors.textMuted} />
          <Text style={tStyles.locText} numberOfLines={1}>{[listing.city, listing.province].filter(Boolean).join(', ')}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

const tStyles = StyleSheet.create({
  card: {
    width: width * 0.62, backgroundColor: colors.surface,
    borderRadius: radius.lg, overflow: 'hidden', ...shadow.sm, marginRight: 12,
  },
  imageWrap: { height: 150, position: 'relative' },
  image: { width: '100%', height: '100%' },
  badge: {
    position: 'absolute', top: 8, left: 8,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.sm,
  },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  body: { padding: 12, gap: 3 },
  price: { fontSize: 15, fontWeight: '800', color: colors.primary },
  title: { fontSize: 13, color: colors.text, lineHeight: 17 },
  loc: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 3 },
  locText: { fontSize: 11, color: colors.textMuted, flex: 1 },
});

function QuickLink({ icon, label, onPress }: { icon: string; label: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={qlStyles.btn} onPress={onPress}>
      <View style={qlStyles.iconWrap}>
        <Ionicons name={icon as any} size={22} color={colors.primary} />
      </View>
      <Text style={qlStyles.label}>{label}</Text>
    </TouchableOpacity>
  );
}

const qlStyles = StyleSheet.create({
  btn: { alignItems: 'center', gap: 8, flex: 1 },
  iconWrap: {
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: colors.accentLight, alignItems: 'center', justifyContent: 'center',
  },
  label: { fontSize: 12, fontWeight: '600', color: colors.text, textAlign: 'center' },
});

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [trending, setTrending] = useState<Listing[]>([]);
  const [loadingTrending, setLoadingTrending] = useState(true);

  useEffect(() => {
    fetch(endpoints.trending)
      .then(r => r.json())
      .then(d => setTrending(d.listings || []))
      .catch(() => {})
      .finally(() => setLoadingTrending(false));
  }, []);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingBottom: 32 }}
      showsVerticalScrollIndicator={false}
    >
      {/* Hero */}
      <View style={[styles.hero, { paddingTop: insets.top + 20 }]}>
        <LogoMark size={38} showName light />
        <View style={styles.heroDivider} />
        <Text style={styles.heroTitle}>Encuentra tu{'\n'}próximo hogar</Text>
        <Text style={styles.heroSub}>Miles de propiedades en todo el país</Text>
      </View>

      {/* Quick links */}
      <View style={styles.section}>
        <View style={styles.quickLinks}>
          <QuickLink icon="key-outline"      label="Comprar"   onPress={() => router.push('/comprar')} />
          <QuickLink icon="calendar-outline" label="Alquilar"  onPress={() => router.push('/alquilar')} />
          <QuickLink icon="business-outline" label="Proyectos" onPress={() => router.push('/proyectos')} />
          <QuickLink icon="search-outline"   label="Buscar"    onPress={() => router.push('/buscar')} />
        </View>
      </View>

      {/* Trending */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Tendencias</Text>
          <TouchableOpacity onPress={() => router.push('/comprar')}>
            <Text style={styles.seeAll}>Ver todo</Text>
          </TouchableOpacity>
        </View>

        {loadingTrending ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : trending.length === 0 ? (
          <View style={styles.emptyTrend}>
            <Text style={styles.emptyText}>Explora propiedades para ver tendencias aquí.</Text>
          </View>
        ) : (
          <FlatList
            data={trending}
            keyExtractor={item => item.id}
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 4 }}
            renderItem={({ item }) => <TrendingCard listing={item} />}
          />
        )}
      </View>

      {/* Category cards */}
      <View style={[styles.section, { paddingHorizontal: 16, gap: 12 }]}>
        <Text style={styles.sectionTitle}>Explorar por categoría</Text>
        {[
          { label: 'Apartamentos en venta', icon: 'business-outline', condition: 'venta', type: 'apartamento' },
          { label: 'Casas en venta',        icon: 'home-outline',     condition: 'venta', type: 'casa' },
          { label: 'Alquileres amueblados', icon: 'bed-outline',      condition: 'alquiler', type: '' },
          { label: 'Nuevos proyectos',      icon: 'construct-outline',condition: 'nueva_construccion', type: '' },
          { label: 'En planos',             icon: 'document-text-outline', condition: 'planos', type: '' },
        ].map(cat => (
          <TouchableOpacity
            key={cat.label}
            style={styles.catCard}
            onPress={() => router.push({
              pathname: '/buscar',
              params: { condition: cat.condition, type: cat.type },
            })}
          >
            <View style={styles.catIcon}>
              <Ionicons name={cat.icon as any} size={20} color={colors.primary} />
            </View>
            <Text style={styles.catLabel}>{cat.label}</Text>
            <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
          </TouchableOpacity>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  hero: {
    backgroundColor: colors.primary,
    paddingHorizontal: 24,
    paddingBottom: 36,
  },
  heroDivider: { height: 20 },
  heroTitle: { fontSize: 32, fontWeight: '900', color: '#fff', lineHeight: 38, marginBottom: 8 },
  heroSub: { fontSize: 15, color: 'rgba(255,255,255,0.75)' },
  section: { marginTop: 24 },
  sectionHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, marginBottom: 12,
  },
  sectionTitle: { fontSize: 18, fontWeight: '800', color: colors.text, paddingHorizontal: 0, marginBottom: 12 },
  seeAll: { fontSize: 13, color: colors.accent, fontWeight: '600' },
  quickLinks: {
    flexDirection: 'row', justifyContent: 'space-around',
    paddingHorizontal: 16, paddingVertical: 20,
    backgroundColor: colors.surface,
    borderRadius: radius.xl, marginHorizontal: 16,
    ...shadow.sm,
  },
  loadingRow: { height: 160, alignItems: 'center', justifyContent: 'center' },
  emptyTrend: { paddingHorizontal: 16, paddingVertical: 20 },
  emptyText: { fontSize: 14, color: colors.textMuted, textAlign: 'center' },
  catCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: colors.surface, borderRadius: radius.md,
    padding: 16, ...shadow.sm,
  },
  catIcon: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: colors.accentLight, alignItems: 'center', justifyContent: 'center',
  },
  catLabel: { flex: 1, fontSize: 14, fontWeight: '600', color: colors.text },
});
