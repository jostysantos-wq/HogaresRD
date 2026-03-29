/**
 * Reusable listings screen used by Comprar, Alquilar, and Proyectos tabs.
 */
import React, { useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, shadow, glass } from '@/constants/theme';
import ListingCard from '@/components/ListingCard';
import FilterSheet from '@/components/FilterSheet';
import GlassButton from '@/components/GlassButton';
import { useListings, ListingsFilters } from '@/hooks/useListings';

interface Props {
  title: string;
  subtitle?: string;
  defaultFilters?: ListingsFilters;
  typeFixed?: string;
}

export default function ListingsScreen({ title, subtitle, defaultFilters = {}, typeFixed }: Props) {
  const insets = useSafeAreaInsets();
  const [filters, setFilters] = useState<ListingsFilters>({ ...defaultFilters });
  const [showFilters, setShowFilters] = useState(false);

  const { listings, total, loading, loadingMore, error, loadMore, reload } = useListings(filters);

  const activeFilterCount = Object.values(filters).filter(v => v && v !== typeFixed).length;

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
          activeOpacity={0.8}
        >
          <BlurView
            intensity={activeFilterCount > 0 ? 0 : glass.button}
            tint="light"
            style={StyleSheet.absoluteFill}
          />
          <View style={styles.filterBtnHighlight} pointerEvents="none" />
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
            <TouchableOpacity onPress={() => setFilters(typeFixed ? { type: typeFixed } : {})}>
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
        typeFixed={typeFixed}
        onClose={() => setShowFilters(false)}
        onApply={f => setFilters(typeFixed ? { ...f, type: typeFixed } : f)}
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
    paddingHorizontal: 16, paddingVertical: 9,
    borderRadius: 24, borderWidth: 1, borderColor: glass.lightBorder,
    overflow: 'hidden', position: 'relative',
    ...glass.shadow,
  },
  filterBtnActive: {
    backgroundColor: glass.darkBg,
    borderColor: glass.darkBorder,
  },
  filterBtnHighlight: {
    position: 'absolute', top: 0, left: 0, right: 0, height: '50%',
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.45)',
  },
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
