import ListingsScreen from '@/components/ListingsScreen';

export default function AlquilarScreen() {
  return (
    <ListingsScreen
      title="Alquilar"
      subtitle="Propiedades en alquiler"
      defaultFilters={{ type: 'alquiler' }}
      typeFixed="alquiler"
    />
  );
}
