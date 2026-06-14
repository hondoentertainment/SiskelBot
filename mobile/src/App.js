import React from 'react';
import { View, ActivityIndicator, StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer, DefaultTheme, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import LoginScreen from './screens/LoginScreen';
import ChatScreen from './screens/ChatScreen';
import ConversationsScreen from './screens/ConversationsScreen';
import KnowledgeScreen from './screens/KnowledgeScreen';
import SettingsScreen from './screens/SettingsScreen';

import { AuthProvider, useAuth } from './store/auth';
import { SettingsProvider, useSettings } from './store/settings';
import { ConversationsProvider } from './store/conversations';
import { getColors } from './theme/colors';

const Stack = createNativeStackNavigator();

function buildNavTheme(themeName) {
  const colors = getColors(themeName);
  const base = themeName === 'dark' ? DarkTheme : DefaultTheme;
  return {
    ...base,
    dark: themeName === 'dark',
    colors: {
      ...base.colors,
      background: colors.background,
      card: colors.surface,
      text: colors.text,
      border: colors.border,
      primary: colors.primary,
      notification: colors.accent,
    },
  };
}

function RootNavigator() {
  const { state: auth } = useAuth();
  const { state: settings } = useSettings();
  const colors = getColors(settings.theme);

  if (auth.loading || settings.loading) {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
          backgroundColor: colors.background,
        }}
      >
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const navTheme = buildNavTheme(settings.theme);

  return (
    <NavigationContainer theme={navTheme}>
      <StatusBar
        barStyle={settings.theme === 'dark' ? 'light-content' : 'dark-content'}
        backgroundColor={colors.background}
      />
      <Stack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: colors.surface },
          headerTitleStyle: { color: colors.text },
          headerTintColor: colors.primary,
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        {auth.authenticated ? (
          <>
            <Stack.Screen
              name="Conversations"
              component={ConversationsScreen}
              options={{ title: 'Conversations' }}
            />
            <Stack.Screen
              name="Chat"
              component={ChatScreen}
              options={{ title: 'Chat' }}
            />
            <Stack.Screen
              name="Knowledge"
              component={KnowledgeScreen}
              options={{ title: 'Knowledge' }}
            />
            <Stack.Screen
              name="Settings"
              component={SettingsScreen}
              options={{ title: 'Settings' }}
            />
          </>
        ) : (
          <Stack.Screen
            name="Login"
            component={LoginScreen}
            options={{ headerShown: false }}
          />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <SettingsProvider>
        <AuthProvider>
          <ConversationsProvider>
            <RootNavigator />
          </ConversationsProvider>
        </AuthProvider>
      </SettingsProvider>
    </SafeAreaProvider>
  );
}
