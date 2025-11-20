import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Database, CheckCircle, AlertCircle, Loader2 } from "lucide-react";
import { apiService } from "@/services/api";

interface DatabaseSetupModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  loading?: boolean;
}

export default function DatabaseSetupModal({ isOpen, onClose, onSuccess, loading = false }: DatabaseSetupModalProps) {
  const [config, setConfig] = useState({
    host: 'localhost',
    port: 5432,
    user: 'postgres',
    password: '',
    database: 'whatsapp_blast',
    ssl: false // Local PostgreSQL typically doesn't use SSL
  });
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const handleTestConnection = async () => {
    setTesting(true);
    setError('');
    setSuccess('');

    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
      const result = token
        ? await apiService.testLocalDbConfig(config)
        : await apiService.testLocalDbConfigSetup(config);
      if (result.ok) {
        setSuccess('Database connection successful!');
      } else {
        setError(result.message || 'Connection failed');
      }
    } catch (err: any) {
      if (err.message.includes('Failed to fetch')) {
        setError('Backend server is not running. Please start the application properly.');
      } else {
        setError(err.message || 'Connection test failed');
      }
    } finally {
      setTesting(false);
    }
  };

  const handleSaveConfig = async () => {
    setSaving(true);
    setError('');
    setSuccess('');

    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
      const result = token
        ? await apiService.saveLocalDbConfig(config)
        : await apiService.saveLocalDbConfigSetup(config);
      setSuccess('✅ Database configuration saved successfully! All tables will be created automatically.');
      
      // Check database status after saving
      try {
        const dbStatus = await apiService.checkDbStatus();
        if (dbStatus.connected) {
          setSuccess('✅ Database configuration saved and connected successfully!');
        } else if (dbStatus.configured) {
          setSuccess('✅ Database configuration saved! Please refresh the page to complete the connection.');
        } else {
          setSuccess('✅ Database configuration saved! Please refresh the page to complete the connection.');
        }
      } catch (statusError) {
        console.warn('Could not check database status:', statusError);
        setSuccess('✅ Database configuration saved! Please refresh the page to complete the connection.');
      }
      
      // Close modal after successful save
      setTimeout(() => {
        onSuccess(); // Call the success callback
        onClose();
        // Refresh the page to reload with new database connection
        setTimeout(() => {
          window.location.reload();
        }, 500);
      }, 2000);
    } catch (err: any) {
      if (err.message.includes('Failed to fetch')) {
        setError('Backend server is not running. Please start the application properly.');
      } else {
        setError(err.message || 'Failed to save configuration');
      }
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <Card className="w-full max-w-md mx-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="w-5 h-5" />
            Database Setup Required
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-8 h-8 animate-spin mr-2" />
              <span>Checking database status...</span>
            </div>
          ) : (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                Please configure your local PostgreSQL database to continue using the application. 
                Make sure PostgreSQL is installed and running on your system.
              </AlertDescription>
            </Alert>
          )}

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="host">Host</Label>
                <Input
                  id="host"
                  value={config.host}
                  onChange={(e) => setConfig({ ...config, host: e.target.value })}
                  placeholder="localhost"
                />
              </div>
              <div>
                <Label htmlFor="port">Port</Label>
                <Input
                  id="port"
                  type="number"
                  value={config.port}
                  onChange={(e) => setConfig({ ...config, port: parseInt(e.target.value) || 5432 })}
                  placeholder="5432"
                />
              </div>
            </div>

            <div>
              <Label htmlFor="database">Database Name</Label>
              <Input
                id="database"
                value={config.database}
                onChange={(e) => setConfig({ ...config, database: e.target.value })}
                placeholder="whatsapp_blast"
              />
            </div>

            <div>
              <Label htmlFor="user">Username</Label>
              <Input
                id="user"
                value={config.user}
                onChange={(e) => setConfig({ ...config, user: e.target.value })}
                placeholder="postgres"
              />
            </div>

            <div>
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={config.password}
                onChange={(e) => setConfig({ ...config, password: e.target.value })}
                placeholder="Enter your database password"
              />
            </div>
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {success && (
            <Alert>
              <CheckCircle className="h-4 w-4" />
              <AlertDescription>{success}</AlertDescription>
            </Alert>
          )}

          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={handleTestConnection}
              disabled={testing || saving}
            >
              {testing && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Test Connection
            </Button>
            <Button
              onClick={handleSaveConfig}
              disabled={testing || saving || !success}
            >
              {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Save & Continue
            </Button>
            <Button
              variant="outline"
              onClick={onClose}
              className="text-gray-600"
            >
              Close
            </Button>
            {error && error.includes('Backend server is not running') && (
              <Button
                variant="outline"
                onClick={() => window.location.reload()}
                className="text-blue-600"
              >
                Retry
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
