import ListingsScreen from '@/components/ListingsScreen';

export default function AlquilarScreen() {
  return (
    <ListingsScreen
      title="Alquilar"
      subtitle="Propiedades en alquiler"
      defaultFilters={{ condition: 'alquiler' }}
      conditionFixed="alquiler"
    />
  );
}
