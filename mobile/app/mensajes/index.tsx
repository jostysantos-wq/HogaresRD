import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, shadow } from '@/constants/theme';
import { endpoints } from '@/constants/api';
import { useAuth } from '@/hooks/useAuth';

interface Conversation {
  id:          string;
  listingId?:  string;
  listingTitle?:string;
  otherName:   string;
  lastMessage: string;
  lastAt:      string;
  unread:      number;
}

function timeAgo(iso: string) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'Ahora';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

export default function MensajesScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, authHeaders } = useAuth();
  const [convos,     setConvos]     = useState<Conversation[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (!isRefresh) setLoading(true);
    try {
      const res = await fetch(endpoints.conversations, { headers: authHeaders() });
      if (!res.ok) throw new Error();
      const data = await res.json();
      const list: Conversation[] = (data.conversations || data || []).map((c: any) => ({
        id:           c.id,
        listingId:    c.listingId,
        listingTitle: c.listingTitle || c.listing_title,
        otherName:    user?.role === 'broker' ? (c.clientName || c.client_name || 'Cliente') : (c.brokerName || c.broker_name || 'Agente'),
        lastMessage:  c.lastMessage || c.last_message || '',
        lastAt:       c.lastAt || c.last_at || c.updatedAt || '',
        unread:       c.unreadCount || c.unread_count || 0,
      }));
      setConvos(list);
    } catch {
      setConvos([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [authHeaders, user]);

  useEffect(() => { if (user) load(); else setLoading(false); }, [user, load]);

  const onRefresh = () => { setRefreshing(true); load(true); };

  if (!user) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <Ionicons name="chatbubbles-outline" size={64} color={colors.border} />
        <Text style={styles.emptyTitle}>Inicia sesión para ver tus mensajes</Text>
        <TouchableOpacity style={styles.loginBtn} onPress={() => router.push('/auth/login')}>
          <Text style={styles.loginBtnText}>Iniciar sesión</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (loading) {
    return <View style={styles.center}><ActivityIndicator size="large" color={colors.primary} /></View>;
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Mensajes</Text>
        {convos.length > 0 && <Text style={styles.headerSub}>{convos.length} conversación{convos.length > 1 ? 'es' : ''}</Text>}
      </View>

      {convos.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="chatbubbles-outline" size={64} color={colors.border} />
          <Text style={styles.emptyTitle}>Sin mensajes aún</Text>
          <Text style={styles.emptySub}>Contacta a un agente desde la página de cualquier propiedad para iniciar una conversación.</Text>
        </View>
      ) : (
        <FlatList
          data={convos}
          keyExtractor={item => item.id}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 32 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.convoRow}
              activeOpacity={0.75}
              onPress={() => router.push(`/mensajes/${item.id}`)}
            >
              <View style={styles.convoAvatar}>
                <Text style={styles.convoAvatarText}>{(item.otherName || '?')[0].toUpperCase()}</Text>
              </View>
              <View style={styles.convoInfo}>
                <View style={styles.convoTop}>
                  <Text style={styles.convoName} numberOfLines={1}>{item.otherName}</Text>
                  <Text style={styles.convoTime}>{timeAgo(item.lastAt)}</Text>
                </View>
                {item.listingTitle && (
                  <Text style={styles.convoListing} numberOfLines={1}>📍 {item.listingTitle}</Text>
                )}
                <View style={styles.convoBottom}>
                  <Text style={[styles.convoLast, item.unread > 0 && styles.convoLastUnread]} numberOfLines={1}>
                    {item.lastMessage || 'Sin mensajes aún'}
                  </Text>
                  {item.unread > 0 && (
                    <View style={styles.unreadBadge}>
                      <Text style={styles.unreadText}>{item.unread > 9 ? '9+' : item.unread}</Text>
                    </View>
                  )}
                </View>
              </View>
            </TouchableOpacity>
          )}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container:  { flex: 1, backgroundColor: colors.bg },
  center:     { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  header: {
    paddingHorizontal: 20, paddingBottom: 14, paddingTop: 8,
    backgroundColor: colors.surface,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  headerTitle: { fontSize: 24, fontWeight: '900', color: colors.primary },
  headerSub:   { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: colors.text, marginTop: 16, marginBottom: 8, textAlign: 'center' },
  emptySub:   { fontSize: 14, color: colors.textMuted, textAlign: 'center', lineHeight: 20 },
  loginBtn: {
    marginTop: 24, backgroundColor: colors.primary,
    paddingHorizontal: 32, paddingVertical: 14,
    borderRadius: radius.md, ...shadow.sm,
  },
  loginBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  convoRow: {
    flexDirection: 'row', alignItems: 'center',
    padding: 16, backgroundColor: colors.surface, gap: 12,
  },
  convoAvatar: {
    width: 46, height: 46, borderRadius: 23,
    backgroundColor: colors.accentLight,
    alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  convoAvatarText: { fontSize: 18, fontWeight: '800', color: colors.accent },
  convoInfo:  { flex: 1 },
  convoTop:   { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 },
  convoName:  { fontSize: 15, fontWeight: '700', color: colors.text, flex: 1 },
  convoTime:  { fontSize: 12, color: colors.textMuted, marginLeft: 8 },
  convoListing: { fontSize: 12, color: colors.textMuted, marginBottom: 3 },
  convoBottom:  { flexDirection: 'row', alignItems: 'center', gap: 8 },
  convoLast:    { fontSize: 13, color: colors.textMuted, flex: 1 },
  convoLastUnread: { color: colors.text, fontWeight: '600' },
  unreadBadge: {
    backgroundColor: colors.accent, borderRadius: 10,
    minWidth: 20, height: 20, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 5,
  },
  unreadText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  separator:  { height: 1, backgroundColor: colors.border, marginLeft: 74 },
});
