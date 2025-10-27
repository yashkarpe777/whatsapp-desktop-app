import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Shield, User, ArrowLeft, RefreshCw, MessageCircle, Zap } from "lucide-react";
import { useNavigate, useLocation } from "react-router-dom";
import { useToast } from "@/hooks/use-toast";
import { verifyOtp as apiVerifyOtp, login as apiLogin } from "@/services/api";

const VerifyOTP = () => {
  const [otp, setOtp] = useState(["", "", "", "", "", ""]);
  const [isLoading, setIsLoading] = useState(false);
  const [timeLeft, setTimeLeft] = useState(60);
  const [canResend, setCanResend] = useState(false);

  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();

  const { phone, email, role, loginMethod } = location.state || {
    phone: "",
    email: "",
    role: "user",
    loginMethod: "phone",
  };

  useEffect(() => {
    if (timeLeft > 0) {
      const timer = setTimeout(() => setTimeLeft(timeLeft - 1), 1000);
      return () => clearTimeout(timer);
    } else {
      setCanResend(true);
    }
  }, [timeLeft]);

  const handleOtpChange = (index: number, value: string) => {
    if (value.length <= 1 && /^\d*$/.test(value)) {
      const newOtp = [...otp];
      newOtp[index] = value;
      setOtp(newOtp);
      if (value !== "" && index < 5) {
        const nextInput = document.getElementById(`otp-${index + 1}`);
        nextInput?.focus();
      }
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && otp[index] === "" && index > 0) {
      const prevInput = document.getElementById(`otp-${index - 1}`);
      prevInput?.focus();
    }
  };

  const handleVerifyOTP = async (e: React.FormEvent) => {
    e.preventDefault();
    const otpCode = otp.join(""); // join array to string

    if (otpCode.length !== 6) {
      toast({ title: "Invalid Code", description: "Enter the complete 6-digit OTP", variant: "destructive" });
      return;
    }

    setIsLoading(true);

    try {
      const data = await apiVerifyOtp(email, otpCode);
      setIsLoading(false);

      // Save token and redirect to unified dashboard
      if (data.token) localStorage.setItem("token", data.token);
      toast({ title: "Verification Successful", description: `Welcome ${role}` });
      
      // Redirect to /app (both admin and user use same dashboard)
      navigate("/app", { replace: true });
    } catch (err: any) {
      console.error(err);
      setIsLoading(false);
      toast({ title: "OTP Verification Failed", description: err.message || "Invalid OTP", variant: "destructive" });
    }
  };

  const handleResendOTP = async () => {
    setTimeLeft(60);
    setCanResend(false);
    setOtp(["", "", "", "", "", ""]);

    try {
      await apiLogin(email);
      toast({ title: "OTP Sent", description: "A new code has been dispatched" });
    } catch (err: any) {
      toast({ title: "Resend Failed", description: err.message || "Could not resend OTP", variant: "destructive" });
    }
  };

  const maskPhone = (phone: string) => {
    if (!phone) return "";
    const cleanPhone = phone.replace(/\D/g, "");
    return `+${cleanPhone.slice(0, 1)} (***) ***-${cleanPhone.slice(-4)}`;
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
              <p className="text-sm text-muted-foreground">Enterprise Login Portal</p>
            </div>
          </div>
        </div>

        <Card className="glass-card">
          <CardHeader className="text-center space-y-6">
            <div className="mx-auto w-16 h-16 bg-primary/20 rounded-full flex items-center justify-center">
              <MessageCircle className="w-8 h-8 text-primary" />
            </div>
            <div>
              <CardTitle className="text-2xl font-bold">OTP Verification</CardTitle>
              <CardDescription className="text-muted-foreground">
                Enter the 6-digit code sent to {loginMethod === "phone" ? maskPhone(phone) : email}
              </CardDescription>
            </div>
          </CardHeader>

          <CardContent className="space-y-6">
            {/* Role Indicator */}
            <div className="flex justify-center">
              <Badge variant="outline" className={`${role === "admin" ? "border-purple-500 text-purple-300" : "border-blue-500 text-blue-300"}`}>
                {role === "admin" ? <Shield className="w-3 h-3 mr-1" /> : <User className="w-3 h-3 mr-1" />}
                {role.charAt(0).toUpperCase() + role.slice(1)} Access
              </Badge>
            </div>

            {/* OTP Input */}
            <form onSubmit={handleVerifyOTP} className="space-y-6">
              <div className="space-y-2">
                <Label className="text-center block">Enter Code</Label>
                <div className="flex justify-center space-x-3">
                  {otp.map((digit, index) => (
                    <Input
                      key={index}
                      id={`otp-${index}`}
                      type="text"
                      inputMode="numeric"
                      maxLength={1}
                      value={digit}
                      onChange={(e) => handleOtpChange(index, e.target.value)}
                      onKeyDown={(e) => handleKeyDown(index, e)}
                      className="w-12 h-12 text-center text-lg font-bold auth-input"
                      autoComplete="off"
                    />
                  ))}
                </div>
              </div>

              <Button type="submit" className="w-full" disabled={isLoading || otp.join("").length !== 6}>
                {isLoading ? (
                  <div className="flex items-center space-x-2">
                    <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    <span>Verifying...</span>
                  </div>
                ) : "Verify"}
              </Button>
            </form>

            {/* Resend OTP */}
            <div className="text-center space-y-3">
              {canResend ? (
                <Button variant="ghost" onClick={handleResendOTP} className="text-primary hover:text-primary/80">
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Resend Code
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">Resend available in {timeLeft}s</p>
              )}
            </div>

            {/* Back to Login */}
            <div className="text-center">
              <Button variant="ghost" onClick={() => navigate("/")} className="text-muted-foreground hover:text-foreground">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Return to Login
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default VerifyOTP;
