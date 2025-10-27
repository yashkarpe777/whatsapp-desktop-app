import React, { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Paperclip } from "lucide-react";
import AttachmentPreview from "@/components/AttachmentPreview";

interface AttachmentLinkProps {
  file?: File | null;
  remoteFileName?: string | null;
  className?: string;
  onRemove?: () => void;
  label?: string;
}

const AttachmentLink: React.FC<AttachmentLinkProps> = ({ file, remoteFileName, className, onRemove, label }) => {
  const [open, setOpen] = useState(false);
  const displayName = useMemo(() => file?.name || remoteFileName || "attachment", [file, remoteFileName]);

  const hasAttachment = !!file || !!remoteFileName;
  if (!hasAttachment) return null;

  return (
    <div className={`flex items-center gap-2 ${className || ''}`}>
      <Button variant="link" className="p-0 h-auto" onClick={() => setOpen(true)}>
        <Paperclip className="w-4 h-4 mr-1" /> {label || displayName}
      </Button>
      {onRemove && (
        <Button variant="ghost" size="sm" onClick={onRemove}>Remove</Button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{displayName}</DialogTitle>
          </DialogHeader>
          <AttachmentPreview file={file} remoteFileName={remoteFileName || null} />
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default AttachmentLink;
