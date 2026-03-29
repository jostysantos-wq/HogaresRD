import React from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Dimensions,
} from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, shadow, CONDITION_COLORS, TYPE_LABELS } from '@/constants/theme';
import type { Listing } from '@/hooks/useListings';

const { width } = Dimensions.get('window');
const CARD_WIDTH = (width - 48) / 2;

function formatPrice(price: number, currency: string, condition: string): string {
  if (!price) return 'Precio a consultar';
  const fmt = new Intl.NumberFormat('es-DO').format(price);
  const sym = currency === 'DOP' ? 'RD$' : '$';
  const suffix = condition === 'alquiler' ? '/mes' : '';
  return `${sym}${fmt}${suffix}`;
}

interface Props {
  listing: Listing;
  wide?: boolean;
}

export default function ListingCard({ listing, wide }: Props) {
  const router = useRouter();
  const condColor = CONDITION_COLORS[listing.condition] || colors.primary;
  const condLabel = listing.condition === 'alquiler' ? 'Alquiler'
    : listing.condition === 'nueva_construccion' ? 'Nueva Constr.'
    : listing.condition === 'planos' ? 'En Planos'
    : 'Venta';

  const imageUri = listing.images?.[0];
  const cardStyle = wide
    ? [styles.card, styles.cardWide]
    : [styles.card, { width: CARD_WIDTH }];

  return (
    <TouchableOpacity
      style={cardStyle}
      activeOpacity={0.92}
      onPress={() => router.push(`/listing/${listing.id}`)}
    >
      <View style={styles.imageWrapper}>
        {imageUri ? (
          <Image
            source={{ uri: imageUri }}
            style={styles.image}
            contentFit="cover"
            transition={200}
          />
        ) : (
          <View style={styles.imagePlaceholder}>
            <Ionicons name="home-outline" size={32} color={colors.border} />
          </View>
        )}
        <View style={[styles.condBadge, { backgroundColor: condColor }]}>
          <Text style={styles.condText}>{condLabel}</Text>
        </View>
        {listing.blueprints?.length ? (
          <View style={styles.bpBadge}>
            <Ionicons name="document-outline" size={10} color="#fff" />
            <Text style={styles.bpText}>Planos</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.body}>
        <Text style={styles.price} numberOfLines={1}>
          {formatPrice(listing.price, listing.currency, listing.condition)}
        </Text>
        <Text style={styles.title} numberOfLines={2}>{listing.title}</Text>
        <View style={styles.meta}>
          <Ionicons name="location-outline" size={11} color={colors.textMuted} />
          <Text style={styles.metaText} numberOfLines={1}>
            {[listing.city, listing.province].filter(Boolean).join(', ')}
          </Text>
        </View>
        {(listing.bedrooms || listing.bathrooms || listing.area) ? (
          <View style={styles.specs}>
            {listing.bedrooms ? (
              <View style={styles.spec}>
                <Ionicons name="bed-outline" size={12} color={colors.textMuted} />
                <Text style={styles.specText}>{listing.bedrooms}</Text>
              </View>
            ) : null}
            {listing.bathrooms ? (
              <View style={styles.spec}>
                <Ionicons name="water-outline" size={12} color={colors.textMuted} />
                <Text style={styles.specText}>{listing.bathrooms}</Text>
              </View>
            ) : null}
            {listing.area ? (
              <View style={styles.spec}>
                <Ionicons name="expand-outline" size={12} color={colors.textMuted} />
                <Text style={styles.specText}>{listing.area}m²</Text>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    overflow: 'hidden',
    marginBottom: 12,
    ...shadow.sm,
  },
  cardWide: {
    width: '100%',
  },
  imageWrapper: {
    position: 'relative',
    height: 140,
    backgroundColor: colors.bg,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  imagePlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#EFF2F7',
  },
  condBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.sm,
  },
  condText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  bpBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: radius.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  bpText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '600',
  },
  body: {
    padding: 10,
    gap: 3,
  },
  price: {
    fontSize: 15,
    fontWeight: '800',
    color: colors.primary,
  },
  title: {
    fontSize: 12,
    color: colors.text,
    fontWeight: '500',
    lineHeight: 16,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginTop: 2,
  },
  metaText: {
    fontSize: 11,
    color: colors.textMuted,
    flex: 1,
  },
  specs: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  spec: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  specText: {
    fontSize: 11,
    color: colors.textMuted,
  },
});
