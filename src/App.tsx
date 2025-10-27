import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, HashRouter, Routes, Route } from "react-router-dom";
import { Layout } from "@/components/Layout";
import ProtectedRoute from "@/components/ProtectedRoute";
import DatabaseSetupModal from "@/components/DatabaseSetupModal";
import ErrorBoundary from "@/components/ErrorBoundary";
import { useDatabaseHealth } from "@/hooks/useDatabaseHealth";
import Dashboard from "./pages/Dashboard";
import Campaigns from "./pages/Campaigns";
import CampaignDetail from "./pages/CampaignDetail";
import ActiveCampaigns from "./pages/ActiveCampaigns";
import Contacts from "./pages/Contacts";
import Login from "./pages/login";
import CoinManagement from "./pages/CoinManagement";
import NotFound from "./pages/NotFound";
import Logs from "./pages/Logs";
import Settings from "./pages/settings";
import Logout from "./pages/Logout";

const queryClient = new QueryClient();

// Use HashRouter when running under Electron/file:// so routing works from a local file path like /C:/...
const isFileProtocol = typeof window !== "undefined" && window.location?.protocol === "file:";
const isElectronUA = typeof navigator !== "undefined" && navigator.userAgent.toLowerCase().includes("electron");
const UseRouter: any = (isFileProtocol || isElectronUA) ? HashRouter : BrowserRouter;

const AppContent = () => {
  const { showSetupModal, setShowSetupModal, refreshHealth, loading } = useDatabaseHealth();

  return (
    <>
      <UseRouter>
        <Routes>
          <Route path="/" element={<Login />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/app" element={<Layout />}>
              <Route index element={<Dashboard />} />
              <Route path="campaigns" element={<Campaigns />} />
              <Route path="campaigns/active" element={<ActiveCampaigns />} />
              <Route path="campaigns/:id" element={<CampaignDetail />} />
              <Route path="logs" element={<Logs />} />
              <Route path="contacts" element={<Contacts />} />
              <Route path="settings" element={<Settings />} />
              <Route path="coin-management" element={<CoinManagement />} />
              <Route path="logout" element={<Logout />} />
            </Route>
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </UseRouter>
      
      <DatabaseSetupModal
        isOpen={showSetupModal}
        onClose={setShowSetupModal}
        onSuccess={refreshHealth}
        loading={loading}
      />
    </>
  );
};

const App = () => (
  <ErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <AppContent />
      </TooltipProvider>
    </QueryClientProvider>
  </ErrorBoundary>
);

export default App;
