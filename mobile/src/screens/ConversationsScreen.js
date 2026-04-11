import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, StyleSheet, Alert, TouchableOpacity, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import ConversationList from '../components/ConversationList';
import { SiskelBotClient } from '../api/client';
import { useAuth } from '../store/auth';
import { useConversations } from '../store/conversations';
import { useSettings } from '../store/settings';
import { getColors } from '../theme/colors';

export default function ConversationsScreen({ navigation }) {
  const { state: auth } = useAuth();
  const { state: settings } = useSettings();
  const { state: convState, actions: convActions } = useConversations();
  const colors = getColors(settings.theme);

  const client = useMemo(
    () => new SiskelBotClient(auth.baseUrl, auth.apiKey),
    [auth.baseUrl, auth.apiKey]
  );

  const [refreshing, setRefreshing] = useState(false);

  const loadConversations = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await client.listConversations();
      const list = Array.isArray(result) ? result : result?.conversations || [];
      convActions.setList(list);
    } catch (e) {
      convActions.setError(e.message || String(e));
    } finally {
      setRefreshing(false);
    }
  }, [client, convActions]);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  const handleSelect = (item) => {
    convActions.setActive(item.id);
    if (navigation && navigation.navigate) {
      navigation.navigate('Chat');
    }
  };

  const handleDelete = (item) => {
    Alert.alert(
      'Delete conversation',
      `Delete "${item.title || 'Untitled'}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await client.deleteConversation(item.id);
              convActions.remove(item.id);
            } catch (e) {
              Alert.alert('Error', String(e.message || e));
            }
          },
        },
      ]
    );
  };

  const handleNewChat = async () => {
    try {
      const created = await client.createConversation('New conversation');
      const id = created?.id || created?.conversation?.id;
      if (id) {
        convActions.setActive(id);
      }
      await loadConversations();
      if (navigation && navigation.navigate) {
        navigation.navigate('Chat');
      }
    } catch (e) {
      convActions.setActive('local');
      if (navigation && navigation.navigate) {
        navigation.navigate('Chat');
      }
    }
  };

  return (
    <SafeAreaView
      edges={['bottom']}
      style={[styles.safe, { backgroundColor: colors.background }]}
    >
      <View
        style={[
          styles.header,
          { backgroundColor: colors.surface, borderBottomColor: colors.border },
        ]}
      >
        <TouchableOpacity
          style={[styles.newButton, { backgroundColor: colors.primary }]}
          onPress={handleNewChat}
        >
          <Text style={styles.newButtonText}>+ New chat</Text>
        </TouchableOpacity>
      </View>
      <ConversationList
        conversations={convState.list}
        activeId={convState.activeId}
        onSelect={handleSelect}
        onDelete={handleDelete}
        onRefresh={loadConversations}
        refreshing={refreshing}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: {
    padding: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  newButton: {
    height: 42,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  newButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
});
