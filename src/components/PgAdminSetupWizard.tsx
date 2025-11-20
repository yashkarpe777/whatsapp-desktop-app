import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { 
  Database, 
  CheckCircle, 
  AlertCircle, 
  Loader2, 
  Download, 
  ExternalLink,
  ArrowRight,
  ArrowLeft
} from "lucide-react";
import { apiService } from "@/services/api";

interface PgAdminSetupWizardProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

const steps = [
  {
    id: 1,
    title: "Download PostgreSQL",
    description: "Install PostgreSQL and PgAdmin on your system"
  },
  {
    id: 2,
    title: "Create Database",
    description: "Create a new database in PgAdmin"
  },
  {
    id: 3,
    title: "Configure Connection",
    description: "Enter your database connection details"
  },
  {
    id: 4,
    title: "Test & Connect",
    description: "Test connection and start using the app"
  }
];

export default function PgAdminSetupWizard({ isOpen, onClose, onSuccess }: PgAdminSetupWizardProps) {
  const [currentStep, setCurrentStep] = useState(1);
  const [config, setConfig] = useState({
    host: 'localhost',
    port: 5432,
    user: 'postgres',
    password: '',
    database: 'whatsapp_blast',
    ssl: false
  });
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const progress = (currentStep / steps.length) * 100;

  const handleNext = () => {
    if (currentStep < steps.length) {
      setCurrentStep(currentStep + 1);
    }
  };

  const handlePrevious = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setError('');
    setSuccess('');

    try {
      const result = await apiService.testLocalDbConfig(config);
      if (result.ok) {
        setSuccess('✅ Database connection successful! Tables will be created automatically.');
      } else {
        setError(`❌ Connection failed: ${result.message}\n\nPlease check:\n• PostgreSQL is running\n• Database 'whatsapp_blast' exists\n• Username/password is correct`);
      }
    } catch (err: any) {
      if (err.message.includes('Failed to fetch')) {
        setError('❌ Backend server is not running. Please start the application properly.');
      } else {
        setError(`❌ Connection failed: ${err.message}\n\nPlease check:\n• PostgreSQL is running\n• Database 'whatsapp_blast' exists\n• Username/password is correct`);
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
      const result = await apiService.saveLocalDbConfig(config);
      setSuccess('✅ Database configuration saved successfully! All tables will be created automatically.');
      
      // Check database status after saving
      try {
        const dbStatus = await apiService.checkDbStatus();
        if (dbStatus.connected) {
          setSuccess('✅ Database configuration saved and connected successfully!');
        } else {
          setSuccess('✅ Database configuration saved! Please refresh the page to complete the connection.');
        }
      } catch (statusError) {
        console.warn('Could not check database status:', statusError);
        setSuccess('✅ Database configuration saved! Please refresh the page to complete the connection.');
      }
      
      // Close modal after successful save
      setTimeout(() => {
        onClose();
        // Refresh the page to reload with new database connection
        setTimeout(() => {
          window.location.reload();
        }, 1000);
      }, 2000);
    } catch (err: any) {
      if (err.message.includes('Failed to fetch')) {
        setError('❌ Backend server is not running. Please start the application properly.');
      } else {
        setError(`❌ Save failed: ${err.message}`);
      }
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="w-5 h-5" />
            PgAdmin Setup Wizard
          </CardTitle>
          <div className="space-y-2">
            <Progress value={progress} className="w-full" />
            <p className="text-sm text-muted-foreground">
              Step {currentStep} of {steps.length}: {steps[currentStep - 1].title}
            </p>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Step 1: Download PostgreSQL */}
          {currentStep === 1 && (
            <div className="space-y-4">
              <Alert>
                <Download className="h-4 w-4" />
                <AlertDescription>
                  First, you need to install PostgreSQL and PgAdmin on your system.
                </AlertDescription>
              </Alert>
              
              <div className="space-y-4">
                <div className="bg-blue-50 dark:bg-blue-950/20 p-4 rounded-lg border border-blue-200 dark:border-blue-800">
                  <h4 className="font-semibold text-blue-900 dark:text-blue-100 mb-2">📥 Download PostgreSQL:</h4>
                  <ol className="text-sm text-blue-800 dark:text-blue-200 space-y-2 list-decimal list-inside">
                    <li>Go to <a href="https://www.postgresql.org/download/" target="_blank" className="text-blue-600 hover:underline inline-flex items-center gap-1">postgresql.org <ExternalLink className="w-3 h-3" /></a></li>
                    <li>Download PostgreSQL for your operating system</li>
                    <li>Run the installer and follow the setup wizard</li>
                    <li>Remember the password you set for the 'postgres' user</li>
                    <li>Make sure to install PgAdmin (it's usually included)</li>
                  </ol>
                </div>

                <div className="bg-green-50 dark:bg-green-950/20 p-4 rounded-lg border border-green-200 dark:border-green-800">
                  <h4 className="font-semibold text-green-900 dark:text-green-100 mb-2">✅ After Installation:</h4>
                  <ul className="text-sm text-green-800 dark:text-green-200 space-y-1 list-disc list-inside">
                    <li>PostgreSQL service should be running automatically</li>
                    <li>You can open PgAdmin from your applications</li>
                    <li>Default connection: localhost:5432, user: postgres</li>
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* Step 2: Create Database */}
          {currentStep === 2 && (
            <div className="space-y-4">
              <Alert>
                <Database className="h-4 w-4" />
                <AlertDescription>
                  Now create a new database in PgAdmin for storing your WhatsApp data.
                </AlertDescription>
              </Alert>
              
              <div className="space-y-4">
                <div className="bg-blue-50 dark:bg-blue-950/20 p-4 rounded-lg border border-blue-200 dark:border-blue-800">
                  <h4 className="font-semibold text-blue-900 dark:text-blue-100 mb-2">🗄️ Create Database in PgAdmin:</h4>
                  <ol className="text-sm text-blue-800 dark:text-blue-200 space-y-2 list-decimal list-inside">
                    <li>Open PgAdmin from your applications</li>
                    <li>Connect to your PostgreSQL server (localhost)</li>
                    <li>Right-click on "Databases" in the left panel</li>
                    <li>Select "Create" → "Database..."</li>
                    <li>Enter database name: <code className="bg-blue-100 dark:bg-blue-900 px-1 rounded">whatsapp_blast</code></li>
                    <li>Click "Save" to create the database</li>
                  </ol>
                </div>

                <div className="bg-amber-50 dark:bg-amber-950/20 p-4 rounded-lg border border-amber-200 dark:border-amber-800">
                  <h4 className="font-semibold text-amber-900 dark:text-amber-100 mb-2">⚠️ Important:</h4>
                  <ul className="text-sm text-amber-800 dark:text-amber-200 space-y-1 list-disc list-inside">
                    <li>Make sure the database name is exactly <code className="bg-amber-100 dark:bg-amber-900 px-1 rounded">whatsapp_blast</code></li>
                    <li>Don't create any tables - the app will create them automatically</li>
                    <li>Make sure PostgreSQL service is running</li>
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Configure Connection */}
          {currentStep === 3 && (
            <div className="space-y-4">
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  Enter your PostgreSQL connection details below.
                </AlertDescription>
              </Alert>
              
              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="host">Host</Label>
                  <Input 
                    id="host"
                    value={config.host}
                    onChange={(e) => setConfig({ ...config, host: e.target.value })}
                    placeholder="localhost"
                  />
                  <p className="text-xs text-muted-foreground mt-1">Usually localhost for local PgAdmin</p>
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
                  <p className="text-xs text-muted-foreground mt-1">Default PostgreSQL port</p>
                </div>
                <div>
                  <Label htmlFor="database">Database Name</Label>
                  <Input 
                    id="database"
                    value={config.database}
                    onChange={(e) => setConfig({ ...config, database: e.target.value })}
                    placeholder="whatsapp_blast"
                  />
                  <p className="text-xs text-muted-foreground mt-1">The database you created in PgAdmin</p>
                </div>
                <div>
                  <Label htmlFor="user">Username</Label>
                  <Input 
                    id="user"
                    value={config.user}
                    onChange={(e) => setConfig({ ...config, user: e.target.value })}
                    placeholder="postgres"
                  />
                  <p className="text-xs text-muted-foreground mt-1">Your PostgreSQL username</p>
                </div>
                <div className="md:col-span-2">
                  <Label htmlFor="password">Password</Label>
                  <Input 
                    id="password"
                    type="password"
                    value={config.password}
                    onChange={(e) => setConfig({ ...config, password: e.target.value })}
                    placeholder="Enter your PostgreSQL password"
                  />
                  <p className="text-xs text-muted-foreground mt-1">The password you set during PostgreSQL installation</p>
                </div>
              </div>
            </div>
          )}

          {/* Step 4: Test & Connect */}
          {currentStep === 4 && (
            <div className="space-y-4">
              <Alert>
                <CheckCircle className="h-4 w-4" />
                <AlertDescription>
                  Test your connection and save the configuration to start using the app.
                </AlertDescription>
              </Alert>
              
              <div className="space-y-4">
                <div className="bg-green-50 dark:bg-green-950/20 p-4 rounded-lg border border-green-200 dark:border-green-800">
                  <h4 className="font-semibold text-green-900 dark:text-green-100 mb-2">✅ What happens after connection:</h4>
                  <ul className="text-sm text-green-800 dark:text-green-200 space-y-1 list-disc list-inside">
                    <li>All tables will be created automatically</li>
                    <li>Campaigns, contacts, and messages will be stored locally</li>
                    <li>Data will persist between app restarts</li>
                    <li>You can manage your data through PgAdmin</li>
                  </ul>
                </div>

                {error && (
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription className="whitespace-pre-line">{error}</AlertDescription>
                  </Alert>
                )}

                {success && (
                  <Alert>
                    <CheckCircle className="h-4 w-4" />
                    <AlertDescription className="whitespace-pre-line">{success}</AlertDescription>
                  </Alert>
                )}

            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={handleTestConnection}
                disabled={testing || saving}
              >
                {testing && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                🔍 Test Connection
              </Button>
              <Button
                onClick={handleSaveConfig}
                disabled={testing || saving || !success}
              >
                {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                💾 Save & Connect
              </Button>
              <Button
                variant="outline"
                onClick={onClose}
                className="text-gray-600"
              >
                Close
              </Button>
            </div>
              </div>
            </div>
          )}

          {/* Navigation */}
          <div className="flex justify-between">
            <Button
              variant="outline"
              onClick={handlePrevious}
              disabled={currentStep === 1}
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Previous
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              {currentStep < steps.length && (
                <Button onClick={handleNext}>
                  Next
                  <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
