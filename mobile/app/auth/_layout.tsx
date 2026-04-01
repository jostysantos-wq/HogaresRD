import { Stack } from 'expo-router';
import { colors } from '@/constants/theme';
import LogoMark from '@/components/LogoMark';

export default function AuthLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle:      { backgroundColor: colors.primary },
        headerTintColor:  '#fff',
        headerTitleStyle: { fontWeight: '700' },
        headerBackTitle:  'Volver',
        headerTitle:      () => <LogoMark size={26} showName light />,
        contentStyle:     { backgroundColor: colors.bg },
      }}
    />
  );
}
