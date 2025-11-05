// ProtectedRoute.tsx
import { Navigate, Outlet } from "react-router-dom";

// Allow API layer to silently refresh tokens; only check presence here
const ProtectedRoute = () => {
  const token = localStorage.getItem("token");
  if (!token) return <Navigate to="/" replace />;
  return <Outlet />;
};

export default ProtectedRoute;
