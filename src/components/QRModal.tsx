import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useState, useEffect } from "react";
import { apiService } from "@/services/api";

interface QRModalProps {
  isOpen: boolean;
  onClose: () => void;
  onReady: () => void;
}

export default function QRModal({ isOpen, onClose, onReady }: QRModalProps) {
  const [qr, setQr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (isOpen) {
      pollQR();
    }
  }, [isOpen]);

  const pollQR = async () => {
    try {
      const status = await apiService.getWhatsAppStatus();
      if (status.ready) {
        onReady();
        onClose();
      } else if (status.qr) {
        setQr(status.qr);
        setLoading(false);
      } else {
        // Retry after delay
        setTimeout(pollQR, 2000);
      }
    } catch (error) {
      console.error('Error polling QR:', error);
      setTimeout(pollQR, 2000);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>WhatsApp Login Required</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center space-y-4">
          {loading ? (
            <div className="text-center">
              <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
              <p>Initializing WhatsApp...</p>
            </div>
          ) : qr ? (
            <>
              <p className="text-sm text-muted-foreground text-center">
                Scan this QR code with your WhatsApp mobile app to login.
              </p>
              <img src={qr} alt="WhatsApp QR Code" className="w-64 h-64" />
              <p className="text-xs text-muted-foreground text-center">
                If the code doesn't work, refresh the page and try again.
              </p>
            </>
          ) : (
            <p>Waiting for QR code...</p>
          )}
          <Button onClick={onClose} variant="outline">
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
