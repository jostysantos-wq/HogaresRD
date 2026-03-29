import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/constants/theme';

type IconName = React.ComponentProps<typeof Ionicons>['name'];

function icon(focused: boolean, active: IconName, inactive: IconName) {
  return <Ionicons name={focused ? active : inactive} size={24} color={focused ? colors.primary : colors.textMuted} />;
}

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: {
          backgroundColor: '#fff',
          borderTopColor: colors.border,
          borderTopWidth: 1,
          paddingBottom: 4,
          height: 60,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600', marginBottom: 2 },
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
    </Tabs>
  );
}
