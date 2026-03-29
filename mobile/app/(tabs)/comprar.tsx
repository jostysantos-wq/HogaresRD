import ListingsScreen from '@/components/ListingsScreen';

export default function ComprarScreen() {
  return (
    <ListingsScreen
      title="Comprar"
      subtitle="Propiedades en venta"
      defaultFilters={{ type: 'venta' }}
      typeFixed="venta"
    />
  );
}
