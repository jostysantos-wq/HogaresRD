import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, ActivityIndicator, TouchableOpacity,
} from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, shadow } from '@/constants/theme';
import { endpoints } from '@/constants/api';
import ListingCard from '@/components/ListingCard';
import type { Listing } from '@/hooks/useListings';

interface AgencyData {
  name: string;
  slug: string;
  listings: Listing[];
  total: number;
  pages: number;
  page: number;
}

export default function InmobiliariaScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const insets   = useSafeAreaInsets();
  const [data, setData]       = useState<AgencyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(false);
  const [page,    setPage]    = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    fetch(`${endpoints.agency(slug)}?page=1&limit=20`)
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(d => { setData(d); setPage(1); })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [slug]);

  const loadMore = () => {
    if (!data || loadingMore || page >= data.pages) return;
    const next = page + 1;
    setLoadingMore(true);
    fetch(`${endpoints.agency(slug!)}?page=${next}&limit=20`)
      .then(r => r.json())
      .then(d => {
        setData(prev => prev ? { ...prev, listings: [...prev.listings, ...d.listings] } : d);
        setPage(next);
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  };

  if (loading) return (
    <View style={styles.center}>
      <ActivityIndicator size="large" color={colors.primary} />
    </View>
  );

  if (error || !data) return (
    <View style={styles.center}>
      <Ionicons name="alert-circle-outline" size={48} color={colors.textMuted} />
      <Text style={styles.errText}>Inmobiliaria no encontrada</Text>
    </View>
  );

  const initial = data.name.charAt(0).toUpperCase();

  return (
    <>
      <Stack.Screen options={{ title: data.name }} />
      <FlatList
        data={data.listings}
        keyExtractor={item => item.id}
        numColumns={2}
        columnWrapperStyle={styles.row}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 32 }}
        ListHeaderComponent={
          <View style={styles.hero}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{initial}</Text>
            </View>
            <Text style={styles.agencyName}>{data.name}</Text>
            <Text style={styles.agencyCount}>{data.total} propiedad{data.total !== 1 ? 'es' : ''} afiliada{data.total !== 1 ? 's' : ''}</Text>
          </View>
        }
        onEndReached={loadMore}
        onEndReachedThreshold={0.4}
        ListFooterComponent={loadingMore ? <ActivityIndicator color={colors.primary} style={{ marginVertical: 16 }} /> : null}
        renderItem={({ item }) => <ListingCard listing={item} />}
      />
    </>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  errText: { fontSize: 16, color: colors.textMuted },
  hero: {
    alignItems: 'center', paddingVertical: 32, paddingHorizontal: 20,
    backgroundColor: colors.surface, marginBottom: 16,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  avatar: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center',
    marginBottom: 12, ...shadow.md,
  },
  avatarText: { fontSize: 32, fontWeight: '900', color: '#fff' },
  agencyName: { fontSize: 22, fontWeight: '800', color: colors.text, textAlign: 'center' },
  agencyCount: { fontSize: 14, color: colors.textMuted, marginTop: 4 },
  row: { justifyContent: 'space-between', gap: 12 },
});
