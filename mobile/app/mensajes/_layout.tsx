import { Stack } from 'expo-router';
import { colors } from '@/constants/theme';
import LogoMark from '@/components/LogoMark';

export default function MensajesLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.primary },
        headerTintColor: '#fff',
        headerTitleStyle: { fontWeight: '700' },
        headerBackTitle: 'Volver',
      }}
    >
      <Stack.Screen name="index" options={{ headerTitle: 'Mensajes', headerBackTitle: 'Cuenta' }} />
      <Stack.Screen
        name="[id]"
        options={{
          headerTitle: () => <LogoMark size={26} showName light />,
          headerBackTitle: 'Mensajes',
        }}
      />
    </Stack>
  );
}
