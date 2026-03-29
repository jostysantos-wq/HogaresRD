/**
 * Reusable listings screen used by Comprar, Alquilar, and Proyectos tabs.
 */
import React, { useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, shadow } from '@/constants/theme';
import ListingCard from '@/components/ListingCard';
import FilterSheet from '@/components/FilterSheet';
import { useListings, ListingsFilters } from '@/hooks/useListings';

interface Props {
  title: string;
  subtitle?: string;
  defaultFilters?: ListingsFilters;
  conditionFixed?: string;
}

export default function ListingsScreen({ title, subtitle, defaultFilters = {}, conditionFixed }: Props) {
  const insets = useSafeAreaInsets();
  const [filters, setFilters] = useState<ListingsFilters>({ ...defaultFilters });
  const [showFilters, setShowFilters] = useState(false);

  const { listings, total, loading, loadingMore, error, loadMore, reload } = useListings(filters);

  const activeFilterCount = Object.values(filters).filter(v => v && v !== conditionFixed).length;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>{title}</Text>
          {subtitle && <Text style={styles.headerSub}>{subtitle}</Text>}
        </View>
        <TouchableOpacity
          style={[styles.filterBtn, activeFilterCount > 0 && styles.filterBtnActive]}
          onPress={() => setShowFilters(true)}
        >
          <Ionicons name="options-outline" size={18} color={activeFilterCount > 0 ? '#fff' : colors.primary} />
          <Text style={[styles.filterBtnText, activeFilterCount > 0 && { color: '#fff' }]}>
            Filtros{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Results count */}
      {!loading && (
        <View style={styles.countRow}>
          <Text style={styles.countText}>
            {total === 0 ? 'Sin resultados' : `${total} propiedad${total !== 1 ? 'es' : ''}`}
          </Text>
          {activeFilterCount > 0 && (
            <TouchableOpacity onPress={() => setFilters(conditionFixed ? { condition: conditionFixed } : {})}>
              <Text style={styles.clearText}>Limpiar filtros</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Error */}
      {error && (
        <View style={styles.errorBox}>
          <Ionicons name="wifi-outline" size={36} color={colors.textMuted} />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={reload}>
            <Text style={styles.retryText}>Reintentar</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Loading skeleton */}
      {loading && !error && (
        <View style={styles.loadingBox}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>Cargando propiedades...</Text>
        </View>
      )}

      {/* List */}
      {!loading && !error && (
        <FlatList
          data={listings}
          keyExtractor={item => item.id}
          numColumns={2}
          columnWrapperStyle={styles.row}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => <ListingCard listing={item} />}
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          refreshControl={<RefreshControl refreshing={false} onRefresh={reload} tintColor={colors.primary} />}
          ListFooterComponent={
            loadingMore ? (
              <View style={styles.moreLoader}>
                <ActivityIndicator size="small" color={colors.primary} />
              </View>
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.emptyBox}>
              <Ionicons name="search-outline" size={48} color={colors.border} />
              <Text style={styles.emptyTitle}>Sin resultados</Text>
              <Text style={styles.emptyText}>Intenta ajustar los filtros para ver más propiedades.</Text>
            </View>
          }
        />
      )}

      <FilterSheet
        visible={showFilters}
        filters={filters}
        conditionFixed={conditionFixed}
        onClose={() => setShowFilters(false)}
        onApply={f => setFilters(conditionFixed ? { ...f, condition: conditionFixed } : f)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 14,
    backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  headerTitle: { fontSize: 22, fontWeight: '800', color: colors.primary },
  headerSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  filterBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: 20, borderWidth: 1.5, borderColor: colors.primary,
    backgroundColor: colors.surface,
  },
  filterBtnActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  filterBtnText: { fontSize: 14, fontWeight: '600', color: colors.primary },
  countRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 8,
  },
  countText: { fontSize: 13, color: colors.textMuted },
  clearText: { fontSize: 13, color: colors.accent, fontWeight: '600' },
  listContent: { paddingHorizontal: 12, paddingBottom: 24 },
  row: { justifyContent: 'space-between', gap: 12 },
  loadingBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingText: { fontSize: 14, color: colors.textMuted },
  errorBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 32 },
  errorText: { fontSize: 15, color: colors.textMuted, textAlign: 'center' },
  retryBtn: { backgroundColor: colors.primary, paddingHorizontal: 24, paddingVertical: 12, borderRadius: radius.md },
  retryText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  emptyBox: { alignItems: 'center', justifyContent: 'center', gap: 12, paddingTop: 80, paddingHorizontal: 32 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: colors.text },
  emptyText: { fontSize: 14, color: colors.textMuted, textAlign: 'center', lineHeight: 20 },
  moreLoader: { paddingVertical: 20, alignItems: 'center' },
});
