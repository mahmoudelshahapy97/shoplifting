import { createContext, useContext } from "react";

const PlatformContext = createContext(null);

/**
 * The seam between the shared console UI and one product's backend. Each
 * console builds this object from its own auth, workspace and API modules
 * (see README.md, "The platform adapter"); the shared shell, auth pages,
 * notifications, live wall and audit log only ever talk to it.
 */
export function PlatformProvider({ value, children }) {
  return <PlatformContext.Provider value={value}>{children}</PlatformContext.Provider>;
}

export function usePlatform() {
  const ctx = useContext(PlatformContext);
  if (!ctx) throw new Error("usePlatform must be used within a PlatformProvider");
  return ctx;
}

export default PlatformContext;
