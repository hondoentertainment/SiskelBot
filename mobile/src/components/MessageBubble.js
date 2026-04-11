import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { getColors } from '../theme/colors';
import { useSettings } from '../store/settings';

function parseBasicMarkdown(text) {
  if (!text) return [{ type: 'text', content: '' }];
  const segments = [];
  const codeBlockRegex = /```([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        type: 'text',
        content: text.slice(lastIndex, match.index),
      });
    }
    segments.push({ type: 'code', content: match[1].trim() });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) });
  }
  return segments;
}

export default function MessageBubble({ role, content, streaming }) {
  const { state: settings } = useSettings();
  const colors = getColors(settings.theme);
  const isUser = role === 'user';
  const segments = useMemo(() => parseBasicMarkdown(content), [content]);

  const bubbleStyle = [
    styles.bubble,
    {
      backgroundColor: isUser ? colors.userBubble : colors.assistantBubble,
      alignSelf: isUser ? 'flex-end' : 'flex-start',
      borderColor: colors.border,
    },
  ];

  return (
    <View style={[styles.container, isUser && styles.containerUser]}>
      <View style={bubbleStyle}>
        {segments.map((seg, idx) =>
          seg.type === 'code' ? (
            <View
              key={idx}
              style={[
                styles.codeBlock,
                { backgroundColor: colors.surfaceAlt, borderColor: colors.border },
              ]}
            >
              <Text style={[styles.codeText, { color: colors.text }]}>
                {seg.content}
              </Text>
            </View>
          ) : (
            <Text key={idx} style={[styles.text, { color: colors.text }]}>
              {seg.content}
              {streaming && idx === segments.length - 1 ? ' |' : ''}
            </Text>
          )
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    paddingHorizontal: 12,
    marginVertical: 4,
    alignItems: 'flex-start',
  },
  containerUser: {
    alignItems: 'flex-end',
  },
  bubble: {
    maxWidth: '85%',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
  text: {
    fontSize: 15,
    lineHeight: 21,
  },
  codeBlock: {
    padding: 10,
    marginVertical: 6,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  codeText: {
    fontFamily: 'Courier',
    fontSize: 13,
    lineHeight: 18,
  },
});
