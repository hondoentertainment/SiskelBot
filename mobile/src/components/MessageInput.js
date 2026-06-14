import React, { useState } from 'react';
import {
  View,
  TextInput,
  TouchableOpacity,
  Text,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { getColors } from '../theme/colors';
import { useSettings } from '../store/settings';

export default function MessageInput({ onSend, disabled, placeholder }) {
  const [text, setText] = useState('');
  const { state: settings } = useSettings();
  const colors = getColors(settings.theme);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 80 : 0}
    >
      <View
        style={[
          styles.container,
          { backgroundColor: colors.surface, borderTopColor: colors.border },
        ]}
      >
        <TextInput
          style={[
            styles.input,
            {
              backgroundColor: colors.inputBackground,
              borderColor: colors.border,
              color: colors.text,
            },
          ]}
          value={text}
          onChangeText={setText}
          placeholder={placeholder || 'Type a message...'}
          placeholderTextColor={colors.textDim}
          multiline
          editable={!disabled}
          onSubmitEditing={handleSend}
          blurOnSubmit={false}
        />
        <TouchableOpacity
          onPress={handleSend}
          disabled={disabled || !text.trim()}
          style={[
            styles.sendButton,
            {
              backgroundColor:
                disabled || !text.trim() ? colors.surfaceAlt : colors.primary,
            },
          ]}
          accessibilityRole="button"
          accessibilityLabel="Send message"
        >
          <Text
            style={[
              styles.sendText,
              { color: disabled || !text.trim() ? colors.textDim : '#ffffff' },
            ]}
          >
            Send
          </Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    minHeight: 42,
    maxHeight: 140,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    marginRight: 8,
  },
  sendButton: {
    paddingHorizontal: 16,
    height: 42,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendText: {
    fontWeight: '600',
    fontSize: 14,
  },
});
