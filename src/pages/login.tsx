import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Lock, Zap, Shield, User as UserIcon } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useToast } from "@/hooks/use-toast";
import { apiService } from "@/services/api";

const Login = () => {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [selectedRole, setSelectedRole] = useState<"admin" | "user" | null>(null); // purely cosmetic

  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (token) {
      navigate('/app', { replace: true });
    }
  }, [navigate]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      const res = await apiService.loginPassword(username.trim(), password);
      if (res?.token) {
        localStorage.setItem('token', res.token);
      }
      // Auto-detect role from token/server; the selectedRole here is only visual
      toast({ title: "Welcome", description: `Signed in as ${res?.user?.username || username}` });
      navigate('/app', { replace: true });
    } catch (err: any) {
      toast({ title: "Login failed", description: err?.message || 'Invalid credentials', variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">
        {/* Branding */}
        <div className="text-center space-y-4">
          <div className="flex items-center justify-center space-x-3">
            <div className="w-12 h-12 whatsapp-branding rounded-xl flex items-center justify-center">
              <Zap className="w-6 h-6 text-white" />
            </div>
            <div className="text-left">
              <h1 className="text-2xl font-bold text-foreground">WhatsApp Blast</h1>
              <p className="text-sm text-muted-foreground">Secure Sign-In</p>
            </div>
          </div>
        </div>

        <Card className="glass-card">
          <CardHeader className="text-center space-y-4">
            <div className="mx-auto w-16 h-16 bg-primary/20 rounded-full flex items-center justify-center">
              <Lock className="w-8 h-8 text-primary" />
            </div>
            <div>
              <CardTitle className="text-2xl font-bold">Sign in</CardTitle>
              <CardDescription className="text-muted-foreground">
                Use your username or email and password
              </CardDescription>
            </div>
          </CardHeader>

          <CardContent className="space-y-6">
            {/* Cosmetic role selection (detection is automatic after login) */}
            <div className="space-y-3">
              <Label className="text-sm font-medium">Role</Label>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setSelectedRole("admin")}
                  className={`p-4 rounded-lg border-2 transition-all duration-300 ${selectedRole === "admin" ? "admin-role border-transparent text-white" : "glass-card border-border hover:border-primary/50"}`}
                >
                  <Shield className="w-6 h-6 mx-auto mb-2" />
                  <div className="text-sm font-medium">Admin</div>
                  <div className="text-xs text-muted-foreground">Full access</div>
                </button>

                <button
                  type="button"
                  onClick={() => setSelectedRole("user")}
                  className={`p-4 rounded-lg border-2 transition-all duration-300 ${selectedRole === "user" ? "user-role border-transparent text-white" : "glass-card border-border hover:border-primary/50"}`}
                >
                  <UserIcon className="w-6 h-6 mx-auto mb-2" />
                  <div className="text-sm font-medium">User</div>
                  <div className="text-xs text-muted-foreground">Standard access</div>
                </button>
              </div>
            </div>

            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="username">Username or Email</Label>
                <Input
                  id="username"
                  placeholder="Enter your username or email"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="auth-input"
                  autoComplete="username"
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="auth-input"
                  autoComplete="current-password"
                  required
                />
              </div>

              <Button type="submit" className="w-full bg-primary hover:bg-primary/90" disabled={isLoading}>
                {isLoading ? (
                  <div className="flex items-center space-x-2">
                    <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    <span>Signing in...</span>
                  </div>
                ) : (
                  <>Sign in</>
                )}
              </Button>
            </form>

            {/* Footer */}
            <div className="text-center text-xs text-muted-foreground">Authorized access only</div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default Login;
