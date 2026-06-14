import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  Switch,
  Alert,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../store/auth';
import { useSettings } from '../store/settings';
import { getColors } from '../theme/colors';

export default function SettingsScreen() {
  const { state: auth, actions: authActions } = useAuth();
  const { state: settings, actions: settingsActions } = useSettings();
  const colors = getColors(settings.theme);

  const [baseUrl, setBaseUrl] = useState(auth.baseUrl);
  const [model, setModel] = useState(settings.model);
  const [temperature, setTemperature] = useState(String(settings.temperature));

  const handleSave = async () => {
    try {
      await authActions.setBaseUrl(baseUrl.trim());
      const temp = parseFloat(temperature);
      await settingsActions.set({
        model: model.trim() || 'default',
        temperature: Number.isFinite(temp) ? temp : 0.7,
      });
      Alert.alert('Saved', 'Settings updated successfully.');
    } catch (e) {
      Alert.alert('Error', String(e.message || e));
    }
  };

  const handleLogout = () => {
    Alert.alert('Log out', 'Are you sure you want to log out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Log out',
        style: 'destructive',
        onPress: () => authActions.logout(),
      },
    ]);
  };

  const toggleTheme = () => {
    settingsActions.set({ theme: settings.theme === 'dark' ? 'light' : 'dark' });
  };

  return (
    <SafeAreaView
      edges={['bottom']}
      style={[styles.safe, { backgroundColor: colors.background }]}
    >
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={[styles.section, { color: colors.textMuted }]}>
          Server
        </Text>
        <Text style={[styles.label, { color: colors.textMuted }]}>
          API base URL
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
          value={baseUrl}
          onChangeText={setBaseUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="https://siskelbot.example.com"
          placeholderTextColor={colors.textDim}
        />

        <Text style={[styles.section, { color: colors.textMuted }]}>
          Model
        </Text>
        <Text style={[styles.label, { color: colors.textMuted }]}>
          Model name
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
          value={model}
          onChangeText={setModel}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="default"
          placeholderTextColor={colors.textDim}
        />

        <Text style={[styles.label, { color: colors.textMuted }]}>
          Temperature
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
          value={temperature}
          onChangeText={setTemperature}
          keyboardType="decimal-pad"
          placeholder="0.7"
          placeholderTextColor={colors.textDim}
        />

        <Text style={[styles.section, { color: colors.textMuted }]}>
          Appearance
        </Text>
        <View style={styles.row}>
          <Text style={[styles.rowLabel, { color: colors.text }]}>
            Dark theme
          </Text>
          <Switch
            value={settings.theme === 'dark'}
            onValueChange={toggleTheme}
            trackColor={{ false: colors.border, true: colors.primary }}
          />
        </View>

        <Text style={[styles.section, { color: colors.textMuted }]}>
          Chat
        </Text>
        <View style={styles.row}>
          <Text style={[styles.rowLabel, { color: colors.text }]}>
            Streaming responses
          </Text>
          <Switch
            value={settings.streamingEnabled}
            onValueChange={(v) => settingsActions.set({ streamingEnabled: v })}
            trackColor={{ false: colors.border, true: colors.primary }}
          />
        </View>
        <View style={styles.row}>
          <Text style={[styles.rowLabel, { color: colors.text }]}>
            Notifications
          </Text>
          <Switch
            value={settings.notificationsEnabled}
            onValueChange={(v) =>
              settingsActions.set({ notificationsEnabled: v })
            }
            trackColor={{ false: colors.border, true: colors.primary }}
          />
        </View>

        <TouchableOpacity
          style={[styles.button, { backgroundColor: colors.primary }]}
          onPress={handleSave}
        >
          <Text style={styles.buttonText}>Save</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, { backgroundColor: colors.error, marginTop: 12 }]}
          onPress={handleLogout}
        >
          <Text style={styles.buttonText}>Log out</Text>
        </TouchableOpacity>

        <Text style={[styles.version, { color: colors.textDim }]}>
          SiskelBot Mobile v1.0.0
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: {
    padding: 20,
    paddingBottom: 48,
  },
  section: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: 20,
    marginBottom: 10,
  },
  label: {
    fontSize: 13,
    marginBottom: 6,
    marginTop: 8,
  },
  input: {
    height: 44,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    fontSize: 14,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  rowLabel: {
    fontSize: 15,
  },
  button: {
    marginTop: 24,
    height: 46,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
  version: {
    marginTop: 24,
    fontSize: 12,
    textAlign: 'center',
  },
});
