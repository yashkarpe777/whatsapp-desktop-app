/// <reference types="vite/client" />

interface Window {
  electronAPI?: {
    restartBackend: () => Promise<{ ok: boolean; message: string }>
  };
}
