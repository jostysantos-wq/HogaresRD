import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  Modal, TextInput,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, glass, PROVINCES } from '@/constants/theme';
import GlassButton from '@/components/GlassButton';
import type { ListingsFilters } from '@/hooks/useListings';

interface Props {
  visible: boolean;
  filters: ListingsFilters;
  onClose: () => void;
  onApply: (f: ListingsFilters) => void;
  showCondition?: boolean;
  typeFixed?: string;
  showConstructora?: boolean;
}

const PRICE_OPTIONS = [
  { label: 'Sin límite', value: '' },
  { label: '$50,000',   value: '50000' },
  { label: '$100,000',  value: '100000' },
  { label: '$200,000',  value: '200000' },
  { label: '$500,000',  value: '500000' },
  { label: '$1,000,000',value: '1000000' },
];

const BEDROOM_OPTIONS = [
  { label: 'Cualquiera', value: '' },
  { label: '1+', value: '1' },
  { label: '2+', value: '2' },
  { label: '3+', value: '3' },
  { label: '4+', value: '4' },
];

type ChipGroupProps = {
  label: string;
  options: { label: string; value: string }[];
  value: string;
  onChange: (v: string) => void;
};

function ChipGroup({ label, options, value, onChange }: ChipGroupProps) {
  return (
    <View style={styles.group}>
      <Text style={styles.groupLabel}>{label}</Text>
      <View style={styles.chips}>
        {options.map(o => (
          <TouchableOpacity
            key={o.value}
            style={[styles.chip, value === o.value && styles.chipActive]}
            onPress={() => onChange(o.value)}
          >
            <Text style={[styles.chipText, value === o.value && styles.chipTextActive]}>
              {o.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

export default function FilterSheet({ visible, filters, onClose, onApply, typeFixed }: Props) {
  const [local, setLocal] = useState<ListingsFilters>({ ...filters });

  const set = (k: keyof ListingsFilters, v: string) =>
    setLocal(prev => ({ ...prev, [k]: v }));

  const provinceOptions = [{ label: 'Todas', value: '' }, ...PROVINCES.map(p => ({ label: p, value: p }))];

  const handleApply = () => {
    onApply(local);
    onClose();
  };

  const handleReset = () => {
    const cleared: ListingsFilters = {};
    if (typeFixed) cleared.type = typeFixed;
    setLocal(cleared);
    onApply(cleared);
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Filtros</Text>
          <TouchableOpacity onPress={onClose} hitSlop={12}>
            <Ionicons name="close" size={24} color={colors.text} />
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.scroll} contentContainerStyle={{ paddingBottom: 120 }}>
          <ChipGroup
            label="Provincia"
            options={provinceOptions}
            value={local.province || ''}
            onChange={v => set('province', v)}
          />

          <View style={styles.group}>
            <Text style={styles.groupLabel}>Ciudad</Text>
            <TextInput
              style={styles.textInput}
              value={local.city || ''}
              onChangeText={v => set('city', v)}
              placeholder="Ej. Piantini, Naco..."
              placeholderTextColor={colors.textLight}
            />
          </View>

          <ChipGroup
            label="Precio mínimo"
            options={PRICE_OPTIONS}
            value={local.priceMin || ''}
            onChange={v => set('priceMin', v)}
          />

          <ChipGroup
            label="Precio máximo"
            options={PRICE_OPTIONS}
            value={local.priceMax || ''}
            onChange={v => set('priceMax', v)}
          />

          <ChipGroup
            label="Habitaciones (mínimo)"
            options={BEDROOM_OPTIONS}
            value={local.bedroomsMin || ''}
            onChange={v => set('bedroomsMin', v)}
          />
        </ScrollView>

        <View style={styles.footer}>
          <BlurView intensity={glass.tabBar} tint="light" style={StyleSheet.absoluteFill} />
          <View style={styles.footerTopEdge} pointerEvents="none" />
          <GlassButton
            label="Limpiar"
            variant="secondary"
            onPress={handleReset}
            style={{ flex: 1 }}
          />
          <GlassButton
            label="Aplicar filtros"
            variant="primary"
            onPress={handleApply}
            style={{ flex: 2 }}
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  headerTitle: { fontSize: 18, fontWeight: '700', color: colors.text },
  scroll: { flex: 1 },
  group: { padding: 20, borderBottomWidth: 1, borderBottomColor: colors.border },
  groupLabel: { fontSize: 13, fontWeight: '700', color: colors.textMuted, marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.5 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 14, paddingVertical: 7,
    borderRadius: 20, borderWidth: 1, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 13, color: colors.text },
  chipTextActive: { color: '#fff', fontWeight: '600' },
  textInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    padding: 12, fontSize: 14, color: colors.text, backgroundColor: colors.surface,
  },
  footer: {
    flexDirection: 'row', gap: 12, padding: 20,
    position: 'relative', overflow: 'hidden',
  },
  footerTopEdge: {
    position: 'absolute', top: 0, left: 0, right: 0, height: 1,
    backgroundColor: 'rgba(255,255,255,0.70)',
  },
});
