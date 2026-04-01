import { Tabs } from 'expo-router';
import { StyleSheet } from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { colors, glass } from '@/constants/theme';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

function icon(focused: boolean, active: IconName, inactive: IconName) {
  return (
    <Ionicons
      name={focused ? active : inactive}
      size={24}
      color={focused ? colors.primary : colors.textMuted}
    />
  );
}

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        // Glass tab bar
        tabBarStyle: {
          position: 'absolute',
          backgroundColor: 'transparent',
          borderTopWidth: 0,
          elevation: 0,
          height: 64,
        },
        tabBarBackground: () => (
          <BlurView
            intensity={glass.tabBar}
            tint="light"
            style={[StyleSheet.absoluteFill, styles.tabBarBlur]}
          />
        ),
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '600',
          marginBottom: 4,
        },
        tabBarItemStyle: { paddingTop: 6 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Inicio',
          tabBarIcon: ({ focused }) => icon(focused, 'home', 'home-outline'),
        }}
      />
      <Tabs.Screen
        name="comprar"
        options={{
          title: 'Comprar',
          tabBarIcon: ({ focused }) => icon(focused, 'key', 'key-outline'),
        }}
      />
      <Tabs.Screen
        name="alquilar"
        options={{
          title: 'Alquilar',
          tabBarIcon: ({ focused }) => icon(focused, 'calendar', 'calendar-outline'),
        }}
      />
      <Tabs.Screen
        name="proyectos"
        options={{
          title: 'Proyectos',
          tabBarIcon: ({ focused }) => icon(focused, 'business', 'business-outline'),
        }}
      />
      <Tabs.Screen
        name="buscar"
        options={{
          title: 'Buscar',
          tabBarIcon: ({ focused }) => icon(focused, 'search', 'search-outline'),
        }}
      />
      <Tabs.Screen
        name="cuenta"
        options={{
          title: 'Cuenta',
          tabBarIcon: ({ focused }) => icon(focused, 'person-circle', 'person-circle-outline'),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBarBlur: {
    borderTopWidth: 0.5,
    borderTopColor: 'rgba(255, 255, 255, 0.6)',
    // Subtle top highlight stripe for glass depth
    overflow: 'hidden',
  },
});
