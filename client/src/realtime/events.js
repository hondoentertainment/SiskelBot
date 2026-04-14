/**
 * Shared constants for the unified realtime WS protocol.
 *
 * These strings are used by both the browser client
 * (client/src/realtime/client.js) and the server handler
 * (routes/realtime-ws.js). Keeping them in one module prevents drift.
 */

// Client -> Server message types
export const CLIENT_SUBSCRIBE = "subscribe";
export const CLIENT_UNSUBSCRIBE = "unsubscribe";
export const CLIENT_PING = "ping";

// Server -> Client message types
export const SERVER_EVENT = "event";
export const SERVER_ACK = "ack";
export const SERVER_PONG = "pong";
export const SERVER_ERROR = "error";

// Well-known channel name prefixes. Consumers can compose their own
// channel ids (e.g. `chat:${conversationId}`) — these are conventions,
// not enforced.
export const CHANNEL_CHAT_PREFIX = "chat:";
export const CHANNEL_RUN_PREFIX = "run:";
export const CHANNEL_PRESENCE_PREFIX = "presence:";

// Error codes surfaced via { type: "error", code, message }
export const ERR_UNAUTHENTICATED = "UNAUTHENTICATED";
export const ERR_BAD_MESSAGE = "BAD_MESSAGE";
export const ERR_INVALID_CHANNEL = "INVALID_CHANNEL";
export const ERR_INTERNAL = "INTERNAL";
