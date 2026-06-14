import React, { createContext, useContext, useEffect, useReducer } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const AUTH_STORAGE_KEY = '@siskelbot/auth';

const initialState = {
  loading: true,
  authenticated: false,
  baseUrl: '',
  apiKey: '',
  userId: null,
  username: null,
};

function reducer(state, action) {
  switch (action.type) {
    case 'HYDRATE':
      return { ...state, ...action.payload, loading: false };
    case 'LOGIN':
      return {
        ...state,
        authenticated: true,
        baseUrl: action.payload.baseUrl,
        apiKey: action.payload.apiKey,
        userId: action.payload.userId || null,
        username: action.payload.username || null,
      };
    case 'LOGOUT':
      return {
        ...state,
        authenticated: false,
        apiKey: '',
        userId: null,
        username: null,
      };
    case 'SET_BASE_URL':
      return { ...state, baseUrl: action.payload };
    default:
      return state;
  }
}

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(AUTH_STORAGE_KEY);
        const payload = raw ? JSON.parse(raw) : {};
        dispatch({
          type: 'HYDRATE',
          payload: {
            authenticated: !!payload.apiKey,
            baseUrl: payload.baseUrl || 'http://localhost:3000',
            apiKey: payload.apiKey || '',
            userId: payload.userId || null,
            username: payload.username || null,
          },
        });
      } catch (e) {
        dispatch({ type: 'HYDRATE', payload: {} });
      }
    })();
  }, []);

  const persist = async (next) => {
    try {
      await AsyncStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(next));
    } catch (e) {
      // ignore
    }
  };

  const actions = {
    login: async ({ baseUrl, apiKey, userId, username }) => {
      dispatch({ type: 'LOGIN', payload: { baseUrl, apiKey, userId, username } });
      await persist({ baseUrl, apiKey, userId, username });
    },
    logout: async () => {
      dispatch({ type: 'LOGOUT' });
      await persist({ baseUrl: state.baseUrl, apiKey: '' });
    },
    setBaseUrl: async (baseUrl) => {
      dispatch({ type: 'SET_BASE_URL', payload: baseUrl });
      await persist({ ...state, baseUrl });
    },
  };

  return (
    <AuthContext.Provider value={{ state, actions }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}

export default AuthContext;
