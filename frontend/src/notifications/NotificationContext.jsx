import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { getAccessToken } from "../auth/tokenStore";
import { notifications as notificationsApi } from "../api/endpoints";
import { usePolling } from "../hooks/usePolling";

const NotificationContext = createContext(null);

/** The socket's "authenticate again" close code (notification_router.py). */
const CLOSE_UNAUTHORIZED = 4401;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const LIST_LIMIT = 20;

/**
 * The signed-in account's incident notifications: the unread count, the
 * bell's list, and `latest`, the last one pushed (pages watch it to refresh).
 *
 * New ones arrive over /api/v1/notifications/ws. The socket sends the access
 * token in its first message; when the server closes it with 4401 (token
 * expired), one authenticated API call lets the axios client refresh the
 * token, and the socket reconnects with the new one. While the socket is down
 * the unread count is polled instead, so a proxy that drops WebSockets costs
 * only immediacy.
 */
export function NotificationProvider({ children }) {
  const [items, setItems] = useState(null);
  const [unread, setUnread] = useState(0);
  const [connected, setConnected] = useState(false);
  const [latest, setLatest] = useState(null);
  const listedRef = useRef(false);

  const loadList = useCallback(async () => {
    const body = await notificationsApi.list({ limit: LIST_LIMIT });
    listedRef.current = true;
    setItems(body.notifications);
    setUnread(body.unread);
    return body;
  }, []);

  // ---------------------------------------------------------------- socket
  useEffect(() => {
    let socket = null;
    let timer = null;
    let delay = RECONNECT_MIN_MS;
    let stopped = false;

    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(open, delay);
      delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    };

    const onMessage = (message) => {
      if (message.type === "hello") {
        delay = RECONNECT_MIN_MS;
        setConnected(true);
        setUnread(message.unread);
        // Anything raised while disconnected belongs in an open list too.
        if (listedRef.current) loadList().catch(() => {});
      } else if (message.type === "notification") {
        const item = message.notification;
        setItems((current) =>
          current ? [item, ...current.filter((n) => n.notification_id !== item.notification_id)].slice(0, LIST_LIMIT) : current
        );
        setUnread((count) => count + 1);
        setLatest(item);
      } else if (message.type === "read") {
        const ids = new Set(message.notification_ids);
        const now = new Date().toISOString();
        setItems((current) =>
          current?.map((n) => (ids.has(n.notification_id) && !n.read_at ? { ...n, read_at: now } : n))
        );
        setUnread(message.unread);
      } else if (message.type === "resync") {
        loadList().catch(() => {});
      }
    };

    function open() {
      const token = getAccessToken();
      if (!token || stopped) return;
      try {
        socket = new WebSocket(notificationsApi.socketUrl());
      } catch {
        schedule();
        return;
      }
      socket.onopen = () => socket.send(JSON.stringify({ type: "auth", token: getAccessToken() }));
      socket.onmessage = (event) => {
        try {
          onMessage(JSON.parse(event.data));
        } catch {
          /* not ours to handle */
        }
      };
      socket.onclose = async (event) => {
        socket = null;
        setConnected(false);
        if (stopped) return;
        if (event.code === CLOSE_UNAUTHORIZED) {
          // Any authenticated call refreshes an expired access token; if the
          // session itself is over, the client sends us to /login instead.
          try {
            await notificationsApi.unreadCount();
          } catch {
            return;
          }
        }
        schedule();
      };
    }

    open();
    return () => {
      stopped = true;
      clearTimeout(timer);
      if (socket) socket.close(1000, "Signed out");
    };
  }, [loadList]);

  // Fallback while the socket is down: the badge stays roughly current.
  usePolling(
    async ({ signal }) => {
      const body = await notificationsApi.unreadCount({ signal });
      setUnread(body.data.unread);
    },
    { intervalMs: 30000, enabled: !connected }
  );

  // ---------------------------------------------------------------- actions
  const markRead = useCallback(async (ids) => {
    const now = new Date().toISOString();
    const chosen = ids ? new Set(ids) : null;
    setItems((current) =>
      current?.map((n) => (!n.read_at && (!chosen || chosen.has(n.notification_id)) ? { ...n, read_at: now } : n))
    );
    const body = await notificationsApi.markRead(ids);
    setUnread(body.data.unread);
    return body;
  }, []);

  const value = useMemo(
    () => ({ items, unread, connected, latest, loadList, markRead }),
    [items, unread, connected, latest, loadList, markRead]
  );
  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}

export function useNotifications() {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error("useNotifications must be used within a NotificationProvider");
  return ctx;
}
