import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

export default function Logout() {
  const navigate = useNavigate();

  useEffect(() => {
    const doLogout = async () => {
      localStorage.removeItem('token');
      navigate('/', { replace: true });
    };
    doLogout();
  }, [navigate]);

  return null;
}
