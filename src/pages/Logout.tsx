import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { apiService } from "@/services/api";

export default function Logout() {
  const navigate = useNavigate();

  useEffect(() => {
    const doLogout = async () => {
      try {
        // Try to disconnect WhatsApp session (non-fatal if fails)
        await apiService.disconnectWhatsApp().catch(() => {});
      } finally {
        localStorage.removeItem('token');
        navigate('/', { replace: true });
      }
    };
    doLogout();
  }, [navigate]);

  return null;
}
