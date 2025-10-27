// ProtectedRoute.tsx
import { Navigate, Outlet } from "react-router-dom";

const ProtectedRoute = () => {
  const token = localStorage.getItem("token");

  if (!token) {
    // No token → redirect to login
    return <Navigate to="/" replace />;
  }

  // Token exists → render child routes
  return <Outlet />;
};

export default ProtectedRoute;