export const darkColors = {
  background: '#0f1115',
  surface: '#1a1d23',
  surfaceAlt: '#242832',
  border: '#2d323d',
  text: '#e6e8eb',
  textMuted: '#9ba1ad',
  textDim: '#6b7280',
  primary: '#4f8cff',
  primaryHover: '#5f9cff',
  accent: '#7c5cff',
  success: '#22c55e',
  warning: '#f59e0b',
  error: '#ef4444',
  userBubble: '#2d4a7a',
  assistantBubble: '#242832',
  inputBackground: '#1a1d23',
  shadow: 'rgba(0, 0, 0, 0.4)',
};

export const lightColors = {
  background: '#ffffff',
  surface: '#f7f8fa',
  surfaceAlt: '#eef0f4',
  border: '#d9dde3',
  text: '#111418',
  textMuted: '#5a6270',
  textDim: '#8b92a0',
  primary: '#2563eb',
  primaryHover: '#1d4ed8',
  accent: '#7c3aed',
  success: '#16a34a',
  warning: '#d97706',
  error: '#dc2626',
  userBubble: '#dbeafe',
  assistantBubble: '#f1f3f7',
  inputBackground: '#ffffff',
  shadow: 'rgba(0, 0, 0, 0.08)',
};

export function getColors(theme) {
  return theme === 'light' ? lightColors : darkColors;
}

export default darkColors;
