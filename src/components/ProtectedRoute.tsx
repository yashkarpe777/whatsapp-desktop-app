// ProtectedRoute.tsx
import { Navigate, Outlet } from "react-router-dom";
import { useEffect, useState } from "react";
import { apiService } from "@/services/api";

const ProtectedRoute = () => {
  const [isValid, setIsValid] = useState<boolean | null>(null);
  const token = localStorage.getItem("token");

  useEffect(() => {
    const validateToken = async () => {
      if (!token) {
        setIsValid(false);
        return;
      }

      try {
        // Validate token with backend
        await apiService.me();
        setIsValid(true);
      } catch (error) {
        console.warn('Token validation failed:', error);
        // Clear invalid token
        localStorage.removeItem('token');
        localStorage.removeItem('loginTime');
        localStorage.removeItem('tokenExpiresAt');
        setIsValid(false);
      }
    };

    validateToken();
  }, [token]);

  if (isValid === null) {
    // Loading state
    return <div className="flex items-center justify-center min-h-screen">Loading...</div>;
  }

  if (!isValid) {
    // Invalid token → redirect to login
    return <Navigate to="/" replace />;
  }

  // Valid token → render child routes
  return <Outlet />;
};

export default ProtectedRoute;