import React, { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { API_BASE_URL } from "@/services/api";

interface AttachmentPreviewProps {
  file?: File | null;
  remoteFileName?: string | null; // filename stored in DB (media_url)
  onRemove?: () => void;
  className?: string;
}

// Derive uploads base from API_BASE_URL (strip trailing /api)
const uploadsBase = API_BASE_URL.replace(/\/?api\/?$/, "") + "/uploads/";

const AttachmentPreview: React.FC<AttachmentPreviewProps> = ({ file, remoteFileName, onRemove, className }) => {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const src = useMemo(() => {
    if (file) return objectUrl;
    if (remoteFileName) return uploadsBase + remoteFileName;
    return null;
  }, [file, objectUrl, remoteFileName]);

  useEffect(() => {
    if (file) {
      const url = URL.createObjectURL(file);
      setObjectUrl(url);
      return () => URL.revokeObjectURL(url);
    }
    return () => {};
  }, [file]);

  if (!src) return null;

  const isVideo = file ? file.type.startsWith("video") : /\.(mp4|mov|webm|mkv|m4v|avi)$/i.test(remoteFileName || "");

  return (
    <Card className={`border-dashed ${className || ""}`}>
      <CardContent className="p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm text-muted-foreground">Attachment Preview</div>
          {onRemove && (
            <Button variant="ghost" size="sm" onClick={onRemove}>Remove</Button>
          )}
        </div>
        <div className="rounded overflow-hidden bg-muted/30 flex items-center justify-center max-h-80">
          {isVideo ? (
            <video src={src} controls className="w-full h-full max-h-80" />
          ) : (
            <img src={src} alt="Attachment preview" className="w-full h-full object-contain max-h-80" />
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export default AttachmentPreview;
