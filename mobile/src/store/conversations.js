import React, { createContext, useContext, useReducer } from 'react';

const initialState = {
  list: [],
  activeId: null,
  messages: {},
  loading: false,
  error: null,
};

function reducer(state, action) {
  switch (action.type) {
    case 'SET_LOADING':
      return { ...state, loading: action.payload };
    case 'SET_ERROR':
      return { ...state, error: action.payload, loading: false };
    case 'SET_LIST':
      return { ...state, list: action.payload, loading: false, error: null };
    case 'SET_ACTIVE':
      return { ...state, activeId: action.payload };
    case 'SET_MESSAGES': {
      const { conversationId, messages } = action.payload;
      return {
        ...state,
        messages: { ...state.messages, [conversationId]: messages },
      };
    }
    case 'APPEND_MESSAGE': {
      const { conversationId, message } = action.payload;
      const existing = state.messages[conversationId] || [];
      return {
        ...state,
        messages: {
          ...state.messages,
          [conversationId]: [...existing, message],
        },
      };
    }
    case 'UPDATE_LAST_MESSAGE': {
      const { conversationId, content } = action.payload;
      const existing = state.messages[conversationId] || [];
      if (existing.length === 0) return state;
      const updated = [...existing];
      const last = { ...updated[updated.length - 1] };
      last.content = content;
      updated[updated.length - 1] = last;
      return {
        ...state,
        messages: { ...state.messages, [conversationId]: updated },
      };
    }
    case 'REMOVE_CONVERSATION': {
      const id = action.payload;
      const { [id]: _, ...rest } = state.messages;
      return {
        ...state,
        list: state.list.filter((c) => c.id !== id),
        messages: rest,
        activeId: state.activeId === id ? null : state.activeId,
      };
    }
    default:
      return state;
  }
}

const ConversationsContext = createContext(null);

export function ConversationsProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const actions = {
    setLoading: (v) => dispatch({ type: 'SET_LOADING', payload: v }),
    setError: (e) => dispatch({ type: 'SET_ERROR', payload: e }),
    setList: (list) => dispatch({ type: 'SET_LIST', payload: list }),
    setActive: (id) => dispatch({ type: 'SET_ACTIVE', payload: id }),
    setMessages: (conversationId, messages) =>
      dispatch({
        type: 'SET_MESSAGES',
        payload: { conversationId, messages },
      }),
    appendMessage: (conversationId, message) =>
      dispatch({
        type: 'APPEND_MESSAGE',
        payload: { conversationId, message },
      }),
    updateLastMessage: (conversationId, content) =>
      dispatch({
        type: 'UPDATE_LAST_MESSAGE',
        payload: { conversationId, content },
      }),
    remove: (id) => dispatch({ type: 'REMOVE_CONVERSATION', payload: id }),
  };

  return (
    <ConversationsContext.Provider value={{ state, actions }}>
      {children}
    </ConversationsContext.Provider>
  );
}

export function useConversations() {
  const ctx = useContext(ConversationsContext);
  if (!ctx) {
    throw new Error('useConversations must be used within a ConversationsProvider');
  }
  return ctx;
}

export default ConversationsContext;
