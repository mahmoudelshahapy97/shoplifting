import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePolling } from "../hooks/usePolling";
import { usePlatform } from "../platform/PlatformContext";

const NotificationsContext = createContext(null);

/** The socket's "authenticate again" close code (notification router). */
const CLOSE_UNAUTHORIZED = 4401;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const LIST_LIMIT = 20;

/**
 * The signed-in account's notifications: the unread count, the bell's list,
 * `latest` (the last one pushed, for the popup) and `version`, which ticks on
 * every push or reconnect so open pages can refetch.
 *
 * New ones arrive over WS /notifications/ws. The socket sends the access
 * token in its first message (never in the URL, which proxies log); when the
 * server closes with 4401 (token expired), one authenticated API call lets
 * the console's HTTP client refresh the token, and the socket reconnects with
 * the new one, backing off exponentially. While the socket is down the unread
 * count is polled instead, so a proxy that drops WebSockets costs only
 * immediacy.
 *
 * Server messages: {type: "hello", unread}, {type: "notification",
 * notification}, {type: "read", notification_ids, unread}, {type: "resync"},
 * {type: "ping"}.
 */
export function NotificationsProvider({ children }) {
  const { api, auth } = usePlatform();
  const notificationsApi = api.notifications;
  const [items, setItems] = useState(null);
  const [unread, setUnread] = useState(0);
  const [connected, setConnected] = useState(false);
  const [latest, setLatest] = useState(null);
  const [version, setVersion] = useState(0);
  const listedRef = useRef(false);
  const userId = auth.user?.user_id ?? auth.user?.id;

  const loadList = useCallback(async () => {
    const body = await notificationsApi.list({ limit: LIST_LIMIT });
    listedRef.current = true;
    setItems(body.items);
    setUnread(body.unread);
    return body;
  }, [notificationsApi]);

  useEffect(() => {
    if (!userId) return undefined;
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
        setVersion((v) => v + 1);
        // Anything raised while disconnected belongs in an open list too.
        if (listedRef.current) loadList().catch(() => {});
      } else if (message.type === "notification") {
        const item = message.notification;
        setItems((current) =>
          current
            ? [item, ...current.filter((n) => n.notification_id !== item.notification_id)].slice(0, LIST_LIMIT)
            : current
        );
        setUnread((count) => (typeof message.unread === "number" ? message.unread : count + 1));
        setLatest(item);
        setVersion((v) => v + 1);
      } else if (message.type === "read") {
        const ids = new Set(message.notification_ids || []);
        const now = new Date().toISOString();
        setItems((current) =>
          current && current.map((n) => ((message.all || ids.has(n.notification_id)) && !n.read_at ? { ...n, read_at: now } : n))
        );
        setUnread(message.unread);
        setVersion((v) => v + 1);
      } else if (message.type === "resync") {
        setVersion((v) => v + 1);
        loadList().catch(() => {});
      }
    };

    function open() {
      const token = auth.getAccessToken();
      if (!token || stopped) return;
      try {
        socket = new WebSocket(notificationsApi.socketUrl());
      } catch {
        schedule();
        return;
      }
      socket.onopen = () => socket.send(JSON.stringify({ type: "auth", token: auth.getAccessToken() }));
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
          // session itself is over, the client signs us out instead.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, loadList, notificationsApi]);

  // Fallback while the socket is down: the badge stays roughly current.
  usePolling(
    async ({ signal }) => {
      const count = await notificationsApi.unreadCount({ signal });
      setUnread((previous) => {
        if (count > previous) setVersion((v) => v + 1);
        return count;
      });
    },
    { intervalMs: 30000, enabled: Boolean(userId) && !connected, deps: [userId] }
  );

  const markRead = useCallback(
    async (ids) => {
      const now = new Date().toISOString();
      const chosen = ids ? new Set(ids) : null;
      setItems((current) =>
        current && current.map((n) => (!n.read_at && (!chosen || chosen.has(n.notification_id)) ? { ...n, read_at: now } : n))
      );
      const body = await notificationsApi.markRead(ids);
      setUnread(body.unread);
      setVersion((v) => v + 1);
      return body;
    },
    [notificationsApi]
  );

  const markUnread = useCallback(
    async (id) => {
      setItems((current) => current && current.map((n) => (n.notification_id === id ? { ...n, read_at: null } : n)));
      const body = await notificationsApi.markUnread(id);
      setUnread(body.unread);
      setVersion((v) => v + 1);
      return body;
    },
    [notificationsApi]
  );

  const value = useMemo(
    () => ({ items, unread, connected, latest, version, loadList, markRead, markUnread }),
    [items, unread, connected, latest, version, loadList, markRead, markUnread]
  );
  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications() {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error("useNotifications must be used within a NotificationsProvider");
  return ctx;
}

/** Severity -> MUI palette key, shared by the bell, the popup and the page. */
export const SEVERITY_TONE = { critical: "error", high: "error", medium: "warning", warning: "warning", low: "info", info: "info", ok: "success" };

/** Opening a notification switches to its workspace and follows its link. */
export function useOpenNotification() {
  const { workspace } = usePlatform();
  const { markRead } = useNotifications();
  return useCallback(
    (item, navigate) => {
      if (!item.read_at) markRead([item.notification_id]).catch(() => {});
      if (item.workspace_id && workspace?.active && workspace.active.workspace_id !== item.workspace_id) {
        workspace.setActive(item.workspace_id);
      }
      navigate(item.link || "/notifications");
    },
    [workspace, markRead]
  );
}

export default NotificationsProvider;
