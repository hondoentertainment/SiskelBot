import React from 'react';
import MessageBubble from './MessageBubble';

export default function StreamingMessage({ content }) {
  return <MessageBubble role="assistant" content={content || ''} streaming />;
}
