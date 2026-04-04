import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useFocusEffect } from 'expo-router';
import { colors, radius, shadow } from '@/constants/theme';
import { endpoints } from '@/constants/api';
import ListingCard from '@/components/ListingCard';
import type { Listing } from '@/hooks/useListings';

const FAV_KEY = 'hogaresrd_favorites';

export async function getFavoriteIds(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(FAV_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export async function toggleFavorite(id: string): Promise<boolean> {
  const ids = await getFavoriteIds();
  const isFav = ids.includes(id);
  const updated = isFav ? ids.filter(i => i !== id) : [...ids, id];
  await AsyncStorage.setItem(FAV_KEY, JSON.stringify(updated));
  return !isFav;
}

export default function FavoritosScreen() {
  const insets = useSafeAreaInsets();
  const [listings, setListings] = useState<Listing[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (!isRefresh) setLoading(true);
    try {
      const ids = await getFavoriteIds();
      if (!ids.length) { setListings([]); return; }
      // Fetch each saved listing in parallel
      const results = await Promise.allSettled(
        ids.map(id => fetch(endpoints.listing(id)).then(r => r.ok ? r.json() : null))
      );
      const valid = results
        .filter((r): r is PromiseFulfilledResult<Listing> => r.status === 'fulfilled' && r.value !== null)
        .map(r => r.value);
      setListings(valid);
    } catch {
      setListings([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Reload whenever this tab comes into focus (so removals from listing detail reflect here)
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = () => { setRefreshing(true); load(true); };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Guardados</Text>
        <Text style={styles.headerSub}>
          {listings.length > 0 ? `${listings.length} propiedad${listings.length > 1 ? 'es' : ''}` : ''}
        </Text>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : listings.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="heart-outline" size={64} color={colors.border} />
          <Text style={styles.emptyTitle}>Sin propiedades guardadas</Text>
          <Text style={styles.emptySub}>
            Toca el ❤ en cualquier propiedad para guardarla aquí y revisarla más tarde.
          </Text>
        </View>
      ) : (
        <FlatList
          data={listings}
          keyExtractor={item => item.id}
          numColumns={2}
          columnWrapperStyle={styles.row}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
          }
          renderItem={({ item }) => <ListingCard listing={item} />}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 16,
    paddingTop: 8,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTitle: { fontSize: 24, fontWeight: '900', color: colors.primary },
  headerSub:   { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 40,
  },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: colors.text, marginTop: 16, marginBottom: 8, textAlign: 'center' },
  emptySub:   { fontSize: 14, color: colors.textMuted, textAlign: 'center', lineHeight: 20 },
  list: { padding: 16, paddingBottom: 40 },
  row:  { justifyContent: 'space-between', marginBottom: 12 },
});
