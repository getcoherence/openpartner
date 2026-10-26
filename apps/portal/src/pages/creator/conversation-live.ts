/**
 * A conversation's live socket (the Network's realtime.ts): who has the
 * thread open, who is typing, and a nudge to refetch when a message or
 * booking change lands. Both sides use it: the brand's thread
 * (admin/NetworkMessages.tsx) and the creator's (CreatorMessages.tsx).
 *
 * The socket is on the Network's own origin, so each connection starts with
 * a one-minute ticket from the side's authenticated proxy (`fetchTicket`,
 * which also says where the socket is). It reconnects with backoff, and a
 * fresh ticket each time. The threads keep polling too, slowly while the
 * socket is up, so nothing depends on it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface LiveTicket {
  ticket: string;
  /** wss://…/realtime; null when the portal can't reach the Network directly. */
  url: string | null;
}

export interface ConversationLive {
  connected: boolean;
  /** Whether the other side has this thread open; null until known. */
  otherOnline: boolean | null;
  /** Who on the other side is typing, or null. */
  typing: string | null;
  /** Call as this side types (true) and stops (false). Throttled here. */
  setTyping: (typing: boolean) => void;
}

/** The Network's realtime.ts accepts only this subprotocol. */
const LIVE_PROTOCOL = 'openpartner-live';
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
/** Re-say "still typing" this often while keys keep coming. */
const TYPING_REPEAT_MS = 2_500;
/** Stop "typing" after this long without a key. */
const TYPING_IDLE_MS = 4_000;
/** Drop the other side's "typing" if they go quiet without saying so. */
const TYPING_STALE_MS = 6_000;

export function useConversationLive(
  conversationId: string,
  side: 'creator' | 'vendor',
  fetchTicket: () => Promise<LiveTicket>,
  onActivity: () => void,
): ConversationLive {
  const [connected, setConnected] = useState(false);
  const [otherOnline, setOtherOnline] = useState<boolean | null>(null);
  const [typing, setTypingName] = useState<string | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const fetchRef = useRef(fetchTicket);
  const activityRef = useRef(onActivity);
  fetchRef.current = fetchTicket;
  activityRef.current = onActivity;
  const sentTyping = useRef(false);
  const lastSent = useRef(0);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stale = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const other = side === 'creator' ? 'vendor' : 'creator';

  useEffect(() => {
    if (!conversationId || typeof WebSocket === 'undefined') return;
    let closed = false;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      if (closed) return;
      retry = setTimeout(() => void connect(), BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
      attempt += 1;
    };

    const connect = async () => {
      let t: LiveTicket;
      try {
        t = await fetchRef.current();
      } catch {
        schedule();
        return;
      }
      if (closed || !t.url) return;
      // The ticket goes in the subprotocol header, not the URL, so it stays
      // out of access logs.
      let socket: WebSocket;
      try {
        socket = new WebSocket(t.url, [LIVE_PROTOCOL, `ticket.${t.ticket}`]);
      } catch {
        schedule();
        return;
      }
      ws.current = socket;
      // Everything below checks it's still the current socket: a replaced
      // one (another thread, a reconnect) must not touch this thread's state.
      socket.onopen = () => {
        if (ws.current !== socket) return;
        attempt = 0;
        setConnected(true);
      };
      socket.onmessage = (ev) => {
        if (ws.current !== socket) return;
        let frame: { type?: string; presence?: Record<string, boolean>; side?: string; name?: string | null; typing?: boolean };
        try {
          frame = JSON.parse(String(ev.data)) as typeof frame;
        } catch {
          return;
        }
        if (!frame || typeof frame !== 'object') return;
        if ((frame.type === 'hello' || frame.type === 'presence') && frame.presence) {
          setOtherOnline(!!frame.presence[other]);
        } else if (frame.type === 'typing' && frame.side === other) {
          clearTimeout(stale.current);
          if (frame.typing) {
            setTypingName(frame.name ?? '');
            stale.current = setTimeout(() => setTypingName(null), TYPING_STALE_MS);
          } else {
            setTypingName(null);
          }
        } else if (frame.type === 'message') {
          // Whatever it was, they've stopped typing it.
          setTypingName(null);
          activityRef.current();
        }
      };
      socket.onclose = () => {
        if (ws.current !== socket) return;
        ws.current = null;
        sentTyping.current = false;
        setConnected(false);
        setOtherOnline(null);
        setTypingName(null);
        schedule();
      };
      socket.onerror = () => socket.close();
    };

    void connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      clearTimeout(idle.current);
      clearTimeout(stale.current);
      const socket = ws.current;
      ws.current = null;
      if (socket) {
        socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
        socket.close();
      }
      sentTyping.current = false;
      setConnected(false);
      setOtherOnline(null);
      setTypingName(null);
    };
  }, [conversationId, other]);

  const setTyping = useCallback((on: boolean) => {
    const socket = ws.current;
    clearTimeout(idle.current);
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (on) {
      idle.current = setTimeout(() => {
        if (sentTyping.current && ws.current?.readyState === WebSocket.OPEN) {
          sentTyping.current = false;
          ws.current.send(JSON.stringify({ type: 'typing', typing: false }));
        }
      }, TYPING_IDLE_MS);
      const now = Date.now();
      if (sentTyping.current && now - lastSent.current < TYPING_REPEAT_MS) return;
      sentTyping.current = true;
      lastSent.current = now;
      socket.send(JSON.stringify({ type: 'typing', typing: true }));
    } else if (sentTyping.current) {
      sentTyping.current = false;
      socket.send(JSON.stringify({ type: 'typing', typing: false }));
    }
  }, []);

  return { connected, otherOnline, typing, setTyping };
}
