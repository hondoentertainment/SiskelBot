import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  Text,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import MessageBubble from '../components/MessageBubble';
import MessageInput from '../components/MessageInput';
import StreamingMessage from '../components/StreamingMessage';
import { SiskelBotClient } from '../api/client';
import { useAuth } from '../store/auth';
import { useSettings } from '../store/settings';
import { useConversations } from '../store/conversations';
import { getColors } from '../theme/colors';

export default function ChatScreen() {
  const { state: auth } = useAuth();
  const { state: settings } = useSettings();
  const { state: convState, actions: convActions } = useConversations();
  const colors = getColors(settings.theme);
  const listRef = useRef(null);

  const client = useMemo(
    () => new SiskelBotClient(auth.baseUrl, auth.apiKey),
    [auth.baseUrl, auth.apiKey]
  );

  const conversationId = convState.activeId || 'local';
  const messages = convState.messages[conversationId] || [];
  const [streamingContent, setStreamingContent] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (listRef.current && (messages.length > 0 || streamingContent)) {
      setTimeout(() => {
        try {
          listRef.current.scrollToEnd({ animated: true });
        } catch (_) {}
      }, 50);
    }
  }, [messages.length, streamingContent]);

  const handleSend = useCallback(
    async (text) => {
      if (sending) return;
      const userMessage = { role: 'user', content: text };
      convActions.appendMessage(conversationId, userMessage);

      const conversationHistory = [...messages, userMessage].map((m) => ({
        role: m.role,
        content: m.content,
      }));

      setSending(true);
      setStreamingContent('');

      try {
        if (settings.streamingEnabled) {
          let accumulated = '';
          const iterator = client.chatStream(conversationHistory, {
            model: settings.model,
            temperature: settings.temperature,
          });
          for await (const chunk of iterator) {
            if (chunk.type === 'delta' && chunk.content) {
              accumulated += chunk.content;
              setStreamingContent(accumulated);
            }
          }
          convActions.appendMessage(conversationId, {
            role: 'assistant',
            content: accumulated,
          });
          setStreamingContent('');
        } else {
          const result = await client.chat(conversationHistory, {
            model: settings.model,
            temperature: settings.temperature,
          });
          const content =
            result?.choices?.[0]?.message?.content ||
            result?.choices?.[0]?.delta?.content ||
            '';
          convActions.appendMessage(conversationId, {
            role: 'assistant',
            content,
          });
        }
      } catch (e) {
        Alert.alert('Chat error', String(e.message || e));
        convActions.appendMessage(conversationId, {
          role: 'assistant',
          content: `Error: ${e.message || e}`,
        });
        setStreamingContent('');
      } finally {
        setSending(false);
      }
    },
    [
      sending,
      messages,
      client,
      settings.streamingEnabled,
      settings.model,
      settings.temperature,
      conversationId,
      convActions,
    ]
  );

  const renderItem = ({ item }) => (
    <MessageBubble role={item.role} content={item.content} />
  );

  return (
    <SafeAreaView
      edges={['bottom']}
      style={[styles.safe, { backgroundColor: colors.background }]}
    >
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(_, idx) => String(idx)}
        renderItem={renderItem}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={{ color: colors.textMuted, textAlign: 'center' }}>
              Start a conversation with SiskelBot.
            </Text>
          </View>
        }
        ListFooterComponent={
          streamingContent ? (
            <StreamingMessage content={streamingContent} />
          ) : sending ? (
            <View style={styles.loader}>
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : null
        }
      />
      <MessageInput onSend={handleSend} disabled={sending} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  listContent: {
    paddingVertical: 12,
    flexGrow: 1,
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  loader: {
    padding: 16,
  },
});
