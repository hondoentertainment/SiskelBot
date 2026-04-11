import React, { createContext, useContext, useEffect, useReducer } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const SETTINGS_STORAGE_KEY = '@siskelbot/settings';

const initialState = {
  loading: true,
  theme: 'dark',
  model: 'default',
  temperature: 0.7,
  streamingEnabled: true,
  notificationsEnabled: true,
  language: 'en',
};

function reducer(state, action) {
  switch (action.type) {
    case 'HYDRATE':
      return { ...state, ...action.payload, loading: false };
    case 'SET':
      return { ...state, ...action.payload };
    case 'RESET':
      return { ...initialState, loading: false };
    default:
      return state;
  }
}

const SettingsContext = createContext(null);

export function SettingsProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(SETTINGS_STORAGE_KEY);
        const payload = raw ? JSON.parse(raw) : {};
        dispatch({ type: 'HYDRATE', payload });
      } catch (e) {
        dispatch({ type: 'HYDRATE', payload: {} });
      }
    })();
  }, []);

  const persist = async (next) => {
    try {
      await AsyncStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
    } catch (e) {
      // ignore
    }
  };

  const actions = {
    set: async (patch) => {
      const next = { ...state, ...patch };
      dispatch({ type: 'SET', payload: patch });
      await persist(next);
    },
    reset: async () => {
      dispatch({ type: 'RESET' });
      await AsyncStorage.removeItem(SETTINGS_STORAGE_KEY);
    },
  };

  return (
    <SettingsContext.Provider value={{ state, actions }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return ctx;
}

export default SettingsContext;
