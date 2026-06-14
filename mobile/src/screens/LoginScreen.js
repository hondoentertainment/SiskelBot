import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../store/auth';
import { useSettings } from '../store/settings';
import { getColors } from '../theme/colors';

export default function LoginScreen() {
  const { state: auth, actions: authActions } = useAuth();
  const { state: settings } = useSettings();
  const colors = getColors(settings.theme);

  const [baseUrl, setBaseUrl] = useState(auth.baseUrl || 'http://localhost:3000');
  const [apiKey, setApiKey] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!baseUrl.trim()) {
      Alert.alert('Missing field', 'Please enter a server URL');
      return;
    }
    setSubmitting(true);
    try {
      await authActions.login({
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        username: 'user',
      });
    } catch (e) {
      Alert.alert('Login failed', String(e.message || e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView
      style={[styles.safe, { backgroundColor: colors.background }]}
    >
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={[styles.title, { color: colors.text }]}>SiskelBot</Text>
        <Text style={[styles.subtitle, { color: colors.textMuted }]}>
          Sign in to your SiskelBot instance
        </Text>

        <Text style={[styles.label, { color: colors.textMuted }]}>
          Server URL
        </Text>
        <TextInput
          style={[
            styles.input,
            {
              backgroundColor: colors.inputBackground,
              color: colors.text,
              borderColor: colors.border,
            },
          ]}
          placeholder="https://siskelbot.example.com"
          placeholderTextColor={colors.textDim}
          value={baseUrl}
          onChangeText={setBaseUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />

        <Text style={[styles.label, { color: colors.textMuted }]}>
          API key
        </Text>
        <TextInput
          style={[
            styles.input,
            {
              backgroundColor: colors.inputBackground,
              color: colors.text,
              borderColor: colors.border,
            },
          ]}
          placeholder="sk-..."
          placeholderTextColor={colors.textDim}
          value={apiKey}
          onChangeText={setApiKey}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />

        <TouchableOpacity
          style={[
            styles.button,
            { backgroundColor: colors.primary, opacity: submitting ? 0.7 : 1 },
          ]}
          onPress={handleSubmit}
          disabled={submitting}
        >
          <Text style={styles.buttonText}>
            {submitting ? 'Signing in...' : 'Sign in'}
          </Text>
        </TouchableOpacity>

        <Text style={[styles.hint, { color: colors.textDim }]}>
          Your credentials are stored securely on-device.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 32,
  },
  label: {
    fontSize: 13,
    marginBottom: 6,
    marginTop: 12,
  },
  input: {
    height: 46,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 14,
    fontSize: 15,
  },
  button: {
    marginTop: 24,
    height: 48,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  hint: {
    fontSize: 12,
    textAlign: 'center',
    marginTop: 20,
  },
});
