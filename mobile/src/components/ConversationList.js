import React from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  RefreshControl,
} from 'react-native';
import { getColors } from '../theme/colors';
import { useSettings } from '../store/settings';

export default function ConversationList({
  conversations,
  onSelect,
  onDelete,
  onRefresh,
  refreshing,
  activeId,
}) {
  const { state: settings } = useSettings();
  const colors = getColors(settings.theme);

  const renderItem = ({ item }) => {
    const active = item.id === activeId;
    return (
      <TouchableOpacity
        style={[
          styles.item,
          {
            backgroundColor: active ? colors.surfaceAlt : colors.surface,
            borderBottomColor: colors.border,
          },
        ]}
        onPress={() => onSelect && onSelect(item)}
        onLongPress={() => onDelete && onDelete(item)}
      >
        <View style={styles.row}>
          <Text
            numberOfLines={1}
            style={[styles.title, { color: colors.text }]}
          >
            {item.title || 'Untitled conversation'}
          </Text>
          {item.updatedAt ? (
            <Text style={[styles.meta, { color: colors.textDim }]}>
              {new Date(item.updatedAt).toLocaleDateString()}
            </Text>
          ) : null}
        </View>
        {item.preview ? (
          <Text
            numberOfLines={2}
            style={[styles.preview, { color: colors.textMuted }]}
          >
            {item.preview}
          </Text>
        ) : null}
      </TouchableOpacity>
    );
  };

  return (
    <FlatList
      data={conversations || []}
      keyExtractor={(item, idx) => String(item.id || idx)}
      renderItem={renderItem}
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={!!refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
          />
        ) : undefined
      }
      ListEmptyComponent={
        <View style={styles.empty}>
          <Text style={{ color: colors.textMuted }}>
            No conversations yet. Start a new chat to begin.
          </Text>
        </View>
      }
      style={{ backgroundColor: colors.background }}
    />
  );
}

const styles = StyleSheet.create({
  item: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
  },
  meta: {
    fontSize: 12,
    marginLeft: 8,
  },
  preview: {
    fontSize: 13,
    marginTop: 4,
  },
  empty: {
    padding: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
