/// <reference types="vite/client" />

interface Window {
  electronAPI?: {
    restartBackend: () => Promise<{ ok: boolean; message: string }>;
    env: {
      ADMIN_API_BASE_URL: string;
      CORE_API_BASE_URL: string;
    };
    localStorage: {
      setItem: (key: string, value: string) => boolean;
      getItem: (key: string) => string | null;
      removeItem: (key: string) => boolean;
    };
  };
}
