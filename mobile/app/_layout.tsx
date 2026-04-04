import { View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { colors } from '@/constants/theme';
import LogoMark from '@/components/LogoMark';
import { AuthProvider } from '@/hooks/useAuth';

export default function RootLayout() {
  return (
    <AuthProvider>
      <View style={{ flex: 1 }}>
        <SafeAreaProvider>
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: colors.primary },
              headerTintColor: '#fff',
              headerTitleStyle: { fontWeight: '700' },
              headerBackTitle: 'Volver',
              contentStyle: { backgroundColor: colors.bg },
            }}
          >
            <Stack.Screen name="(tabs)"  options={{ headerShown: false }} />
            <Stack.Screen name="auth"    options={{ headerShown: false }} />
            <Stack.Screen
              name="listing/[id]"
              options={{
                headerShown: true,
                headerTitle: () => <LogoMark size={28} showName light />,
                headerBackTitle: 'Volver',
              }}
            />
            <Stack.Screen
              name="inmobiliaria/[slug]"
              options={{
                headerShown: true,
                headerTitle: () => <LogoMark size={28} showName light />,
                headerBackTitle: 'Volver',
              }}
            />
            <Stack.Screen
              name="mensajes"
              options={{ headerShown: false }}
            />
            <Stack.Screen
              name="(tabs)/favoritos"
              options={{ headerShown: false }}
            />
          </Stack>
        </SafeAreaProvider>
      </View>
    </AuthProvider>
  );
}
