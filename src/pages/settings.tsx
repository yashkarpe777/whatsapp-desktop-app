import { useEffect, useState, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Upload, Phone, User, Mail, Database, Wand2 } from "lucide-react";
import { apiService } from "@/services/api";

import PgAdminSetupWizard from "@/components/PgAdminSetupWizard";

export default function Settings() {
  const [profileName, setProfileName] = useState("");
  const [username, setUsername] = useState("");
  const dbRef = useRef<{ host?: string; port?: number; user?: string; password?: string; database?: string; ssl?: boolean }>({ host: 'localhost', port: 5432, user: 'postgres', password: '', database: 'whatsapp_blast', ssl: false });
  const [email, setEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [waStatus, setWaStatus] = useState<{ ready: boolean; number?: string } | null>(null);
  const [showSetupWizard, setShowSetupWizard] = useState(false);

  // User details card
  const [me, setMe] = useState<{ id: number; email: string; username: string; role: string; coins: number } | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const [settings, user] = await Promise.all([
          apiService.getSettings().catch(() => ({ whatsapp_number: '', profile_name: '', email: '' } as any)),
          apiService.me().catch(() => null),
        ]);
        if (settings) {
          setProfileName(settings.profile_name || "");
          setEmail(settings.email || "");
        }
        if (user) { setMe(user); setUsername(user.username || ""); }
      } catch (e) {
        console.error('Failed to load settings', e);
      } finally {
        setLoading(false);
      }
    };
    const loadWA = async () => {
      try {
        const status = await apiService.getWhatsAppStatusLight();
        setWaStatus(status as any);
      } catch {}
    };
    load();
    loadWA();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiService.updateSettings({
        profile_name: profileName,
        email,
      });
      alert("✅ Settings saved successfully!");
    } catch (e) {
      alert("❌ Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const checkWhatsAppStatus = async () => {
    try {
      const status = await apiService.getWhatsAppStatus();
      setWaStatus(status);
      if (status.ready) {
        alert(`✅ WhatsApp Connected: ${status.number || 'Unknown number'}`);
      } else {
        alert("❌ WhatsApp Not Connected");
      }
    } catch (e) {
      alert("❌ Failed to check WhatsApp status");
      setWaStatus({ ready: false });
    }
  };

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-3xl font-bold mb-4">Settings</h1>

      {/* User Details */}
      <Card className="bg-gradient-glass border-glass-border backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <User className="w-5 h-5 text-accent" />
            User Details
          </CardTitle>
        </CardHeader>
        <CardContent className="grid md:grid-cols-2 gap-4">
          <div>
            <Label>Username</Label>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div>
            <Label>Email</Label>
            <Input value={me?.email || ''} readOnly />
          </div>
          <div>
            <Label>Role</Label>
            <Input value={me?.role || ''} readOnly />
          </div>
        </CardContent>
      </Card>

      {/* Database (Local PgAdmin) */}
      <Card className="bg-gradient-glass border-glass-border backdrop-blur-sm">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Database className="w-5 h-5" />
              Local PgAdmin Database Setup
            </CardTitle>
            <Button
              variant="outline"
              onClick={() => setShowSetupWizard(true)}
              className="flex items-center gap-2"
            >
              <Wand2 className="w-4 h-4" />
              Setup Wizard
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Setup Instructions */}
          <div className="bg-blue-50 dark:bg-blue-950/20 p-4 rounded-lg border border-blue-200 dark:border-blue-800">
            <h4 className="font-semibold text-blue-900 dark:text-blue-100 mb-2">📋 Setup Instructions:</h4>
            <ol className="text-sm text-blue-800 dark:text-blue-200 space-y-1 list-decimal list-inside">
              <li>Download and install PostgreSQL from <a href="https://www.postgresql.org/download/" target="_blank" className="text-blue-600 hover:underline">postgresql.org</a></li>
              <li>Open PgAdmin and create a new database named <code className="bg-blue-100 dark:bg-blue-900 px-1 rounded">whatsapp_blast</code></li>
              <li>Fill in your PostgreSQL connection details below</li>
              <li>Click "Test Connection" to verify</li>
              <li>Click "Save & Connect" to store data locally</li>
            </ol>
          </div>

          {/* Connection Form */}
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="dbhost">Host</Label>
              <Input 
                id="dbhost" 
                placeholder="localhost" 
                defaultValue="localhost"
                onChange={(e) => (dbRef.current.host = e.target.value)} 
              />
              <p className="text-xs text-muted-foreground mt-1">Usually localhost for local PgAdmin</p>
            </div>
            <div>
              <Label htmlFor="dbport">Port</Label>
              <Input 
                id="dbport" 
                placeholder="5432" 
                defaultValue="5432"
                onChange={(e) => (dbRef.current.port = Number(e.target.value || 5432))} 
              />
              <p className="text-xs text-muted-foreground mt-1">Default PostgreSQL port</p>
            </div>
            <div>
              <Label htmlFor="dbname">Database Name</Label>
              <Input 
                id="dbname" 
                placeholder="whatsapp_blast" 
                defaultValue="whatsapp_blast"
                onChange={(e) => (dbRef.current.database = e.target.value)} 
              />
              <p className="text-xs text-muted-foreground mt-1">Create this database in PgAdmin first</p>
            </div>
            <div>
              <Label htmlFor="dbuser">Username</Label>
              <Input 
                id="dbuser" 
                placeholder="postgres" 
                defaultValue="postgres"
                onChange={(e) => (dbRef.current.user = e.target.value)} 
              />
              <p className="text-xs text-muted-foreground mt-1">Your PostgreSQL username</p>
            </div>
            <div className="md:col-span-2">
              <Label htmlFor="dbpass">Password</Label>
              <Input 
                id="dbpass" 
                type="password" 
                placeholder="Enter your PostgreSQL password" 
                onChange={(e) => (dbRef.current.password = e.target.value)} 
              />
              <p className="text-xs text-muted-foreground mt-1">The password you set during PostgreSQL installation</p>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-wrap gap-2">
            <Button 
              variant="outline" 
              onClick={async () => {
                try {
                  const r = await apiService.testLocalDbConfig(dbRef.current);
                  if (r.ok) {
                    alert('✅ Database connection successful! Tables will be created automatically.');
                  } else {
                    alert(`❌ Connection failed: ${r.message}\n\nPlease check:\n• PostgreSQL is running\n• Database 'whatsapp_blast' exists\n• Username/password is correct`);
                  }
                } catch (e: any) {
                  alert(`❌ Connection failed: ${e?.message || 'Error'}\n\nPlease check:\n• PostgreSQL is running\n• Database 'whatsapp_blast' exists\n• Username/password is correct`);
                }
              }}
            >
              🔍 Test Connection
            </Button>
            <Button 
              variant="default" 
              onClick={async () => {
                try {
                  const r = await apiService.saveLocalDbConfig(dbRef.current);
                  alert(`✅ ${r.message || 'Database configuration saved! All tables will be created automatically.'}`);
                  
                  // Check database status after saving
                  try {
                    const dbStatus = await apiService.checkDbStatus();
                    if (dbStatus.connected) {
                      alert('✅ Database is now connected! All pages will work with PgAdmin.');
                    } else {
                      alert('✅ Database configuration saved! Please refresh the page to complete the connection.');
                    }
                  } catch (statusError) {
                    console.warn('Could not check database status:', statusError);
                    alert('✅ Database configuration saved! Please refresh the page to complete the connection.');
                  }
                  
                  // Refresh the page to reload with new database connection
                  setTimeout(() => {
                    window.location.reload();
                  }, 2000);
                } catch (e: any) {
                  alert(`❌ Save failed: ${e?.message || 'Error'}`);
                }
              }}
            >
              💾 Save & Connect
            </Button>
            {typeof window !== 'undefined' && window.electronAPI?.restartBackend && (
              <Button 
                variant="outline" 
                onClick={async () => {
                  try {
                    const res = await window.electronAPI!.restartBackend();
                    alert(res.ok ? '✅ Backend restarted successfully' : `❌ Restart failed: ${res.message}`);
                  } catch (e: any) {
                    alert(`❌ Restart failed: ${e?.message || 'Error'}`);
                  }
                }}
              >
                🔄 Restart Backend
              </Button>
            )}
          </div>

          {/* Status Information */}
          <div className="bg-green-50 dark:bg-green-950/20 p-3 rounded-lg border border-green-200 dark:border-green-800">
            <h4 className="font-semibold text-green-900 dark:text-green-100 mb-1">✅ What happens after connection:</h4>
            <ul className="text-sm text-green-800 dark:text-green-200 space-y-1 list-disc list-inside">
              <li>All tables will be created automatically</li>
              <li>Campaigns, contacts, and messages will be stored locally</li>
              <li>Data will persist between app restarts</li>
              <li>You can manage your data through PgAdmin</li>
            </ul>
          </div>
        </CardContent>
      </Card>

      {/* WhatsApp Session */}
      <Card className="bg-gradient-glass border-glass-border backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Phone className="w-5 h-5 text-primary" />
            WhatsApp Session
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-4">
          <div className={`text-sm ${waStatus?.ready ? 'text-green-600' : 'text-yellow-600'}`}>
            {waStatus?.ready ? `Active: +${waStatus?.number || ''}` : 'Not connected'}
          </div>
          <div className="flex gap-2">
            <Button
              variant="default"
              onClick={async () => {
                try {
                  await apiService.whatsappInit();
                  const status = await apiService.getWhatsAppStatusLight();
                  setWaStatus(status as any);
                } catch (error) {
                  console.error('Failed to launch WhatsApp session:', error);
                }
              }}
            >
              {waStatus?.ready ? 'Reconnect WhatsApp' : 'Launch WhatsApp'}
            </Button>

            <Button
              variant="outline"
              onClick={async () => {
                try {
                  await apiService.disconnectWhatsApp();
                  const status = await apiService.getWhatsAppStatusLight();
                  setWaStatus(status as any);
                } catch {}
              }}
            >
              Disconnect
            </Button>
            <Button
              variant="outline"
              onClick={async () => {
                try {
                  await apiService.whatsappCleanProfile();
                  const status = await apiService.getWhatsAppStatusLight();
                  setWaStatus(status as any);
                  alert('WhatsApp profile cleared. Please launch WhatsApp again.');
                } catch {
                  alert('Failed to clear profile');
                }
              }}
            >
              Clean Profile
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Setup Wizard Modal */}
      <PgAdminSetupWizard
        isOpen={showSetupWizard}
        onClose={() => setShowSetupWizard(false)}
        onSuccess={() => {
          setShowSetupWizard(false);
          // The wizard will handle page refresh internally
        }}
      />
    </div>
  );
}