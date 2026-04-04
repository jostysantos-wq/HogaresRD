import { View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { colors } from '@/constants/theme';
import LogoMark from '@/components/LogoMark';
import { AuthProvider, useAuth } from '@/hooks/useAuth';
import { AppLockProvider, useAppLock } from '@/hooks/useAppLock';
import LockScreen from '@/components/LockScreen';

function AppContent() {
  const { user } = useAuth();
  const { isLocked } = useAppLock();

  return (
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

        {/* Lock screen overlay — covers everything when app is locked */}
        {isLocked && user && <LockScreen />}
      </SafeAreaProvider>
    </View>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <AppLockProvider>
        <AppContent />
      </AppLockProvider>
    </AuthProvider>
  );
}
