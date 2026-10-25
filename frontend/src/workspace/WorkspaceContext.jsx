import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { setWorkspaceId } from "../api/client";
import { workspaces as workspacesApi } from "../api/endpoints";
import { useAuth } from "../auth/AuthContext";

const STORAGE_KEY = "shoplifting:workspace";
const WorkspaceContext = createContext(null);

function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * The signed-in user's workspaces and the active one. The active id rides on
 * every API call as X-Workspace-Id and is remembered per browser. AppLayout
 * keys the page on it, so switching workspace reloads whatever is open.
 */
export function WorkspaceProvider({ children }) {
  const { user } = useAuth();
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [chosenId, setChosenId] = useState(readStored);

  const reload = useCallback(async () => {
    if (!user) {
      setList([]);
      return;
    }
    try {
      setList(await workspacesApi.mine());
      setError(null);
    } catch (err) {
      setError(err);
      setList((current) => current || []);
    }
  }, [user]);

  useEffect(() => {
    reload();
  }, [reload]);

  // A remembered workspace that is gone (deleted, or access removed) falls
  // back to the first one, which is what the API would use too.
  const active = useMemo(
    () =>
      (list || []).find((workspace) => workspace.workspace_id === chosenId) ||
      (list || [])[0] ||
      null,
    [list, chosenId]
  );

  // Set during render rather than in an effect: pages fetch in their own
  // effects, which run before this provider's, and must already send it.
  setWorkspaceId(active?.workspace_id ?? null);

  const setActive = useCallback((id) => {
    setChosenId(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* storage blocked: the choice lasts until reload */
    }
  }, []);

  const value = useMemo(
    () => ({ workspaces: list || [], ready: list !== null, error, active, setActive, reload }),
    [list, error, active, setActive, reload]
  );
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used within a WorkspaceProvider");
  return ctx;
}

export default WorkspaceContext;
