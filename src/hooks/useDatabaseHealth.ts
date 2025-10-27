import { useState, useEffect } from 'react';
import { apiService } from '@/services/api';

interface DatabaseHealth {
  status: 'ok' | 'degraded' | 'error';
  databases: {
    render: boolean;
    local: boolean;
  };
  errors: string[];
}

export function useDatabaseHealth() {
  const [health, setHealth] = useState<DatabaseHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [showSetupModal, setShowSetupModal] = useState(false);
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
  
  // Check if user has dismissed the modal recently (within last hour)
  const isModalDismissedRecently = () => {
    if (typeof window === 'undefined') return false;
    const dismissed = localStorage.getItem('dbSetupModalDismissed');
    if (!dismissed) return false;
    const dismissedTime = parseInt(dismissed);
    const oneHour = 60 * 60 * 1000;
    return Date.now() - dismissedTime < oneHour;
  };
  
  // Mark modal as dismissed
  const dismissModal = () => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('dbSetupModalDismissed', Date.now().toString());
    }
    setShowSetupModal(false);
  };

  const checkHealth = async () => {
    if (!token) {
      // Not authenticated yet: do not check DB health and do not show modal
      setShowSetupModal(false);
      setLoading(false);
      return;
    }
    try {
      // Use the backend URL for health check
      const backendUrl = import.meta.env?.VITE_API_BASE_URL_CORE?.replace('/api', '') || 'http://localhost:3000';
      console.log('Checking health at:', `${backendUrl}/health`);
      const response = await fetch(`${backendUrl}/health`);
      
      if (!response.ok) {
        // If health check fails with 500, don't show modal - backend has issues
        if (response.status === 500) {
          console.warn('Health check returned 500 - backend has issues, not showing setup modal');
          setHealth({
            status: 'error',
            databases: { render: false, local: false },
            errors: ['Backend health check failed']
          });
          return;
        }
        throw new Error(`Health check failed with status: ${response.status}`);
      }
      
      const data = await response.json();
      console.log('Health check response:', data);
      setHealth(data);
      
      // Show setup modal if local database is not available (but check if it's configured first)
      if (!data.databases.local) {
        console.log('Local database not available, checking if configured...');
        // Don't show modal if user dismissed it recently
        if (!isModalDismissedRecently()) {
          // Check if database is configured before showing modal
          checkDatabaseStatus();
        }
      } else {
        console.log('Local database is available, hiding setup modal');
        setShowSetupModal(false);
      }
    } catch (error) {
      console.error('Health check failed:', error);
      setHealth({
        status: 'error',
        databases: { render: false, local: false },
        errors: ['Health check failed']
      });
      // Show setup modal if health check fails (backend might not be running)
      setShowSetupModal(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    checkHealth();
    // Check health every 2 minutes only when authenticated (less aggressive)
    if (!token) return;
    const interval = setInterval(checkHealth, 120000);
    return () => clearInterval(interval);
  }, [token]);

  // Also check health when the component mounts and show modal if needed
  useEffect(() => {
    if (!token) {
      setShowSetupModal(false);
      return;
    }
    if (health && !health.databases.local && health.status !== 'error') {
      setShowSetupModal(true);
    } else if (health && health.databases.local) {
      setShowSetupModal(false);
    }
  }, [health, token]);

  // Check database status directly
  const checkDatabaseStatus = async () => {
    if (!token) return;
    try {
      const dbStatus = await apiService.checkDbStatus();
      console.log('Database status check:', dbStatus);
      if (dbStatus.connected) {
        console.log('Database is connected, hiding setup modal');
        setShowSetupModal(false);
        // Clear dismissal flag since DB is now connected
        if (typeof window !== 'undefined') {
          localStorage.removeItem('dbSetupModalDismissed');
        }
      } else if (!dbStatus.configured) {
        console.log('Database not configured, showing setup modal');
        if (!isModalDismissedRecently()) {
          setShowSetupModal(true);
        }
      } else {
        console.log('Database configured but not connected, keeping modal hidden');
        // Database is configured but not connected - don't show modal repeatedly
        // User can manually open settings if needed
        setShowSetupModal(false);
      }
    } catch (error) {
      console.warn('Could not check database status:', error);
    }
  };

  // Check database status on mount
  useEffect(() => {
    checkDatabaseStatus();
  }, [token]);

  const refreshHealth = () => {
    setLoading(true);
    checkHealth();
  };

  return {
    health,
    loading,
    showSetupModal,
    setShowSetupModal: dismissModal,
    refreshHealth
  };
}
