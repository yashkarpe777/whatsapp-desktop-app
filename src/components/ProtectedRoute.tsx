// ProtectedRoute.tsx
import { Navigate, Outlet } from "react-router-dom";
import { useEffect, useState } from "react";
import { apiService } from "@/services/api";

// Allow API layer to silently refresh tokens; only check presence here
const ProtectedRoute = () => {
  const [isValid, setIsValid] = useState<boolean | null>(null);
  const token = localStorage.getItem("token");
  if (!token) return <Navigate to="/" replace />;
  return <Outlet />;
};

export default ProtectedRoute;
