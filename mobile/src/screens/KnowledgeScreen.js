import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SiskelBotClient } from '../api/client';
import { useAuth } from '../store/auth';
import { useSettings } from '../store/settings';
import { getColors } from '../theme/colors';

export default function KnowledgeScreen() {
  const { state: auth } = useAuth();
  const { state: settings } = useSettings();
  const colors = getColors(settings.theme);

  const client = useMemo(
    () => new SiskelBotClient(auth.baseUrl, auth.apiKey),
    [auth.baseUrl, auth.apiKey]
  );

  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await client.listKnowledge();
      const docs = Array.isArray(res) ? res : res?.documents || [];
      setResults(docs);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const handleSearch = async () => {
    if (!query.trim()) {
      loadAll();
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await client.searchKnowledge(query.trim());
      const docs = Array.isArray(res) ? res : res?.results || res?.documents || [];
      setResults(docs);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  const renderItem = ({ item }) => (
    <View
      style={[
        styles.item,
        { backgroundColor: colors.surface, borderBottomColor: colors.border },
      ]}
    >
      <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
        {item.title || item.id || 'Untitled'}
      </Text>
      {item.snippet || item.preview || item.content ? (
        <Text
          style={[styles.preview, { color: colors.textMuted }]}
          numberOfLines={3}
        >
          {item.snippet || item.preview || item.content}
        </Text>
      ) : null}
    </View>
  );

  return (
    <SafeAreaView
      edges={['bottom']}
      style={[styles.safe, { backgroundColor: colors.background }]}
    >
      <View
        style={[
          styles.searchBar,
          { backgroundColor: colors.surface, borderBottomColor: colors.border },
        ]}
      >
        <TextInput
          style={[
            styles.input,
            {
              backgroundColor: colors.inputBackground,
              color: colors.text,
              borderColor: colors.border,
            },
          ]}
          value={query}
          onChangeText={setQuery}
          placeholder="Search knowledge base..."
          placeholderTextColor={colors.textDim}
          onSubmitEditing={handleSearch}
          returnKeyType="search"
        />
        <TouchableOpacity
          style={[styles.button, { backgroundColor: colors.primary }]}
          onPress={handleSearch}
        >
          <Text style={styles.buttonText}>Search</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={{ color: colors.error }}>{error}</Text>
        </View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item, idx) => String(item.id || idx)}
          renderItem={renderItem}
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={{ color: colors.textMuted }}>
                No documents found.
              </Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  searchBar: {
    flexDirection: 'row',
    padding: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
  },
  input: {
    flex: 1,
    height: 40,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    fontSize: 14,
    marginRight: 8,
  },
  button: {
    paddingHorizontal: 14,
    height: 40,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  buttonText: {
    color: '#ffffff',
    fontWeight: '600',
    fontSize: 14,
  },
  item: {
    padding: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 4,
  },
  preview: {
    fontSize: 13,
    lineHeight: 18,
  },
  center: {
    padding: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
