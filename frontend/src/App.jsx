import { AppProviders } from "@insighteye/ui";
import { AuthProvider } from "./auth/AuthContext";
import { PlatformBridge, APP_KEY } from "./platform/PlatformBridge";
import AppRouter from "./routes/AppRouter";
import { WorkspaceProvider } from "./workspace/WorkspaceContext";

export default function App() {
  return (
    <AppProviders appKey={APP_KEY}>
      <AuthProvider>
        <WorkspaceProvider>
          <PlatformBridge>
            <AppRouter />
          </PlatformBridge>
        </WorkspaceProvider>
      </AuthProvider>
    </AppProviders>
  );
}
