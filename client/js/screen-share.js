/**
 * Phase 41.5: WebRTC screen-share client.
 *
 * Wraps the browser RTCPeerConnection / getDisplayMedia APIs and routes
 * signaling messages over an existing SiskelBot WebSocket connection.
 *
 * Usage:
 *   import { createScreenShareClient } from './screen-share.js';
 *   const client = createScreenShareClient(window.SiskelWS);
 *   const stream = await client.startShare({ workspaceId: 'team-1' });
 *
 * Exposed on window.SiskelScreenShare for HTML pages that don't use modules.
 */

const API_BASE = (typeof window !== 'undefined' && window.SISKELBOT_API_BASE) || '/api/v1';

const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/**
 * @typedef {Object} WSManager
 * @property {(msg: any) => void} send - Send a JSON message over the WebSocket
 * @property {(handler: (msg: any) => void) => () => void} onMessage - Subscribe to incoming messages; returns an unsubscribe fn
 * @property {string} [sessionId] - Local session id (set after connect)
 */

/**
 * Create a screen-share controller bound to a WebSocket transport.
 * @param {WSManager} wsManager
 * @param {object} [options]
 * @returns {object}
 */
export function createScreenShareClient(wsManager, options) {
  const opts = Object.assign({
    iceServers: DEFAULT_ICE_SERVERS,
    apiBase: API_BASE,
  }, options || {});

  /** @type {Map<string, RTCPeerConnection>} sessionId -> peer connection */
  const peers = new Map();
  /** @type {Map<string, MediaStream>} sessionId -> remote stream (for viewers) */
  const remoteStreams = new Map();

  let role = null; // 'host' | 'viewer' | null
  let currentRoomId = null;
  let localStream = null;

  const peerJoinedCallbacks = [];
  const peerLeftCallbacks = [];
  const streamCallbacks = [];
  const errorCallbacks = [];

  let unsubscribeWs = null;

  function notify(list, ...args) {
    for (const cb of list) {
      try { cb(...args); } catch (e) { console.warn('[screen-share] callback error', e); }
    }
  }

  function emitError(err) {
    notify(errorCallbacks, err);
  }

  function getSessionId() {
    return (wsManager && (wsManager.sessionId || wsManager.connId)) || null;
  }

  function ensureWsSubscription() {
    if (unsubscribeWs) return;
    if (!wsManager || typeof wsManager.onMessage !== 'function') return;
    unsubscribeWs = wsManager.onMessage((msg) => {
      if (!msg || typeof msg !== 'object') return;
      try {
        handleSignalingMessage(msg);
      } catch (err) {
        emitError(err);
      }
    });
  }

  async function handleSignalingMessage(msg) {
    if (msg.type === 'peer_joined' && msg.roomId === currentRoomId) {
      notify(peerJoinedCallbacks, { sessionId: msg.sessionId, userId: msg.userId });
      // Host: when a viewer joins, create offer for them.
      if (role === 'host' && localStream) {
        await createOfferForPeer(msg.sessionId);
      }
      return;
    }

    if (msg.type === 'peer_left' && msg.roomId === currentRoomId) {
      cleanupPeer(msg.sessionId);
      notify(peerLeftCallbacks, { sessionId: msg.sessionId, userId: msg.userId });
      return;
    }

    if (msg.type === 'screen_share_ended' && msg.roomId === currentRoomId) {
      stopShare();
      return;
    }

    if (msg.type === 'webrtc_signal') {
      const fromSession = msg.from;
      const signal = msg.signal || {};
      let pc = peers.get(fromSession);

      if (signal.type === 'offer') {
        // Viewer receives offer from host.
        if (!pc) {
          pc = createPeerConnection(fromSession);
          peers.set(fromSession, pc);
        }
        await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        wsManager.send({
          type: 'webrtc_answer',
          roomId: currentRoomId,
          to: fromSession,
          signal: answer.sdp,
        });
        return;
      }

      if (signal.type === 'answer' && pc) {
        await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
        return;
      }

      if (signal.type === 'ice' && pc && signal.candidate) {
        try {
          await pc.addIceCandidate(signal.candidate);
        } catch (err) {
          console.warn('[screen-share] addIceCandidate failed', err);
        }
        return;
      }
    }
  }

  function createPeerConnection(remoteSessionId) {
    const pc = new RTCPeerConnection({ iceServers: opts.iceServers });

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      wsManager.send({
        type: 'webrtc_ice',
        roomId: currentRoomId,
        to: remoteSessionId,
        candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate,
      });
    };

    pc.ontrack = (event) => {
      const stream = event.streams && event.streams[0];
      if (stream) {
        remoteStreams.set(remoteSessionId, stream);
        notify(streamCallbacks, { sessionId: remoteSessionId, stream });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        cleanupPeer(remoteSessionId);
      }
    };

    // If we are the host and already have a local stream, attach tracks.
    if (role === 'host' && localStream) {
      for (const track of localStream.getTracks()) {
        pc.addTrack(track, localStream);
      }
    }

    return pc;
  }

  async function createOfferForPeer(remoteSessionId) {
    let pc = peers.get(remoteSessionId);
    if (!pc) {
      pc = createPeerConnection(remoteSessionId);
      peers.set(remoteSessionId, pc);
    }
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    wsManager.send({
      type: 'webrtc_offer',
      roomId: currentRoomId,
      to: remoteSessionId,
      signal: offer.sdp,
    });
  }

  function cleanupPeer(sessionId) {
    const pc = peers.get(sessionId);
    if (pc) {
      try { pc.close(); } catch (_) {}
      peers.delete(sessionId);
    }
    remoteStreams.delete(sessionId);
  }

  async function apiPost(path, body) {
    const res = await fetch(`${opts.apiBase}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`POST ${path} failed: ${res.status} ${text}`);
    }
    return res.json();
  }

  async function apiGet(path) {
    const res = await fetch(`${opts.apiBase}${path}`, { credentials: 'include' });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GET ${path} failed: ${res.status} ${text}`);
    }
    return res.json();
  }

  async function apiDelete(path) {
    const res = await fetch(`${opts.apiBase}${path}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`DELETE ${path} failed: ${res.status} ${text}`);
    }
    return res.json();
  }

  /**
   * Start sharing the local screen. Returns the captured MediaStream.
   * @param {object} [shareOpts]
   * @param {string} [shareOpts.workspaceId]
   * @param {string} [shareOpts.title]
   * @param {MediaStreamConstraints} [shareOpts.constraints]
   */
  async function startShare(shareOpts) {
    const sOpts = shareOpts || {};
    if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      throw new Error('getDisplayMedia is not supported in this environment');
    }
    const sessionId = getSessionId();
    if (!sessionId) {
      throw new Error('WebSocket session is not available; connect first');
    }

    ensureWsSubscription();

    const constraints = sOpts.constraints || { video: { cursor: 'always' }, audio: false };
    localStream = await navigator.mediaDevices.getDisplayMedia(constraints);

    // Auto-stop when the user clicks the browser's "Stop sharing" button.
    for (const track of localStream.getTracks()) {
      track.addEventListener('ended', () => {
        stopShare();
      });
    }

    const created = await apiPost('/screen-share/rooms', {
      sessionId,
      workspaceId: sOpts.workspaceId,
      title: sOpts.title || 'Screen share',
    });
    currentRoomId = created.room.id;
    role = 'host';

    // Tell other workspace members the share is live.
    wsManager.send({
      type: 'screen_share_started',
      roomId: currentRoomId,
      title: sOpts.title || 'Screen share',
    });

    return localStream;
  }

  /**
   * Join an existing share as a viewer. Returns a MediaStream once the host
   * sends an offer and the connection is established.
   * @param {string} roomId
   */
  async function joinShare(roomId) {
    if (!roomId) throw new Error('roomId is required');
    const sessionId = getSessionId();
    if (!sessionId) throw new Error('WebSocket session is not available');

    ensureWsSubscription();
    role = 'viewer';
    currentRoomId = roomId;

    await apiPost(`/screen-share/rooms/${encodeURIComponent(roomId)}/join`, { sessionId });

    // Wait for the host's offer/answer exchange to produce a stream.
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timed out waiting for host stream'));
      }, 30_000);
      const off = onStream(({ stream }) => {
        clearTimeout(timeout);
        try { off(); } catch (_) {}
        resolve(stream);
      });
    });
  }

  function stopShare() {
    if (localStream) {
      for (const track of localStream.getTracks()) {
        try { track.stop(); } catch (_) {}
      }
      localStream = null;
    }
    if (currentRoomId && role === 'host') {
      wsManager.send({
        type: 'screen_share_ended',
        roomId: currentRoomId,
      });
      apiDelete(`/screen-share/rooms/${encodeURIComponent(currentRoomId)}`).catch(() => {});
    }
    for (const sid of Array.from(peers.keys())) cleanupPeer(sid);
    currentRoomId = null;
    role = null;
  }

  function leaveRoom() {
    for (const sid of Array.from(peers.keys())) cleanupPeer(sid);
    currentRoomId = null;
    role = null;
    if (unsubscribeWs) {
      try { unsubscribeWs(); } catch (_) {}
      unsubscribeWs = null;
    }
  }

  function onPeerJoined(cb) {
    peerJoinedCallbacks.push(cb);
    return () => {
      const i = peerJoinedCallbacks.indexOf(cb);
      if (i >= 0) peerJoinedCallbacks.splice(i, 1);
    };
  }

  function onPeerLeft(cb) {
    peerLeftCallbacks.push(cb);
    return () => {
      const i = peerLeftCallbacks.indexOf(cb);
      if (i >= 0) peerLeftCallbacks.splice(i, 1);
    };
  }

  function onStream(cb) {
    streamCallbacks.push(cb);
    // Replay any streams already received.
    for (const [sid, stream] of remoteStreams.entries()) {
      try { cb({ sessionId: sid, stream }); } catch (_) {}
    }
    return () => {
      const i = streamCallbacks.indexOf(cb);
      if (i >= 0) streamCallbacks.splice(i, 1);
    };
  }

  function onError(cb) {
    errorCallbacks.push(cb);
    return () => {
      const i = errorCallbacks.indexOf(cb);
      if (i >= 0) errorCallbacks.splice(i, 1);
    };
  }

  /**
   * Get aggregate connection statistics for all peer connections.
   */
  async function getStats() {
    const result = {
      role,
      roomId: currentRoomId,
      peerCount: peers.size,
      peers: [],
    };
    for (const [sid, pc] of peers.entries()) {
      const entry = {
        sessionId: sid,
        connectionState: pc.connectionState,
        iceConnectionState: pc.iceConnectionState,
        signalingState: pc.signalingState,
      };
      try {
        const reports = await pc.getStats();
        let bytesSent = 0;
        let bytesReceived = 0;
        let packetsLost = 0;
        reports.forEach((report) => {
          if (report.type === 'outbound-rtp') bytesSent += report.bytesSent || 0;
          if (report.type === 'inbound-rtp') {
            bytesReceived += report.bytesReceived || 0;
            packetsLost += report.packetsLost || 0;
          }
        });
        entry.bytesSent = bytesSent;
        entry.bytesReceived = bytesReceived;
        entry.packetsLost = packetsLost;
      } catch (_) {}
      result.peers.push(entry);
    }
    return result;
  }

  async function listRooms(workspaceId) {
    const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
    return apiGet(`/screen-share/rooms${qs}`);
  }

  return {
    startShare,
    joinShare,
    stopShare,
    leaveRoom,
    listRooms,
    onPeerJoined,
    onPeerLeft,
    onStream,
    onError,
    getStats,
    get role() { return role; },
    get roomId() { return currentRoomId; },
    get localStream() { return localStream; },
  };
}

if (typeof window !== 'undefined') {
  window.SiskelScreenShare = { createScreenShareClient };
}
