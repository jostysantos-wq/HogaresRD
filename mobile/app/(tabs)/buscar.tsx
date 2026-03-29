import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity,
  FlatList, ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { colors, radius } from '@/constants/theme';
import ListingCard from '@/components/ListingCard';
import FilterSheet from '@/components/FilterSheet';
import { useListings, ListingsFilters } from '@/hooks/useListings';

export default function BuscarScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ condition?: string; type?: string }>();

  const [query, setQuery]         = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters]     = useState<ListingsFilters>({
    condition: params.condition || '',
    type:      params.type      || '',
  });

  const { listings, total, loading, loadingMore, loadMore, reload } = useListings(filters);

  // Client-side text search on top of API results
  const filtered = query.trim()
    ? listings.filter(l =>
        l.title.toLowerCase().includes(query.toLowerCase()) ||
        l.city?.toLowerCase().includes(query.toLowerCase()) ||
        l.province?.toLowerCase().includes(query.toLowerCase()) ||
        l.description?.toLowerCase().includes(query.toLowerCase())
      )
    : listings;

  const activeCount = Object.values(filters).filter(Boolean).length;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Search bar */}
      <View style={styles.searchBar}>
        <View style={styles.inputWrap}>
          <Ionicons name="search-outline" size={18} color={colors.textMuted} style={styles.searchIcon} />
          <TextInput
            style={styles.input}
            value={query}
            onChangeText={setQuery}
            placeholder="Ciudad, provincia, título..."
            placeholderTextColor={colors.textLight}
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
        </View>
        <TouchableOpacity
          style={[styles.filterBtn, activeCount > 0 && styles.filterBtnActive]}
          onPress={() => setShowFilters(true)}
        >
          <Ionicons name="options-outline" size={18} color={activeCount > 0 ? '#fff' : colors.primary} />
          {activeCount > 0 && <Text style={styles.filterCount}>{activeCount}</Text>}
        </TouchableOpacity>
      </View>

      {/* Count */}
      {!loading && (
        <Text style={styles.countText}>
          {filtered.length} resultado{filtered.length !== 1 ? 's' : ''}
          {query ? ` para "${query}"` : ''}
        </Text>
      )}

      {loading ? (
        <View style={styles.loadingBox}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={item => item.id}
          numColumns={2}
          columnWrapperStyle={styles.row}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => <ListingCard listing={item} />}
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          ListFooterComponent={loadingMore ? <ActivityIndicator color={colors.primary} style={{ marginVertical: 16 }} /> : null}
          ListEmptyComponent={
            <View style={styles.emptyBox}>
              <Ionicons name="search-outline" size={48} color={colors.border} />
              <Text style={styles.emptyTitle}>Sin resultados</Text>
              <Text style={styles.emptyText}>Prueba con otro término o ajusta los filtros.</Text>
            </View>
          }
        />
      )}

      <FilterSheet
        visible={showFilters}
        filters={filters}
        onClose={() => setShowFilters(false)}
        onApply={setFilters}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  searchBar: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    padding: 12, backgroundColor: colors.surface,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  inputWrap: {
    flex: 1, flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.bg, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, paddingHorizontal: 10,
  },
  searchIcon: { marginRight: 8 },
  input: { flex: 1, height: 42, fontSize: 15, color: colors.text },
  filterBtn: {
    width: 44, height: 44, borderRadius: radius.md,
    borderWidth: 1.5, borderColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  filterBtnActive: { backgroundColor: colors.primary },
  filterCount: {
    position: 'absolute', top: -4, right: -4,
    backgroundColor: colors.danger, width: 16, height: 16,
    borderRadius: 8, alignItems: 'center', justifyContent: 'center',
  },
  countText: { fontSize: 13, color: colors.textMuted, paddingHorizontal: 16, paddingVertical: 8 },
  listContent: { paddingHorizontal: 12, paddingBottom: 24 },
  row: { justifyContent: 'space-between', gap: 12 },
  loadingBox: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyBox: { alignItems: 'center', gap: 12, paddingTop: 80, paddingHorizontal: 32 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: colors.text },
  emptyText: { fontSize: 14, color: colors.textMuted, textAlign: 'center', lineHeight: 20 },
});
