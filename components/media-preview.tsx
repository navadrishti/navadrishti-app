"use client";

import { useEffect, useState } from "react";

type MediaPreviewProps = {
  blob: Blob;
  remoteUrl?: string;
  mimeType: string;
  label: string;
};

export function MediaPreview({ blob, remoteUrl, mimeType, label }: MediaPreviewProps) {
  const [url, setUrl] = useState<string | null>(remoteUrl || null);

  useEffect(() => {
    if (blob.size > 0) {
      const objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
      return () => URL.revokeObjectURL(objectUrl);
    } else if (remoteUrl) {
      setUrl(remoteUrl);
    }
  }, [blob, remoteUrl]);

  return (
    <div className="media-frame">
      {url && mimeType.startsWith("video/") ? (
        <video controls preload="metadata" src={url} />
      ) : url ? (
        <img alt={label} src={url} />
      ) : null}
      <div className="media-caption">
        <span>{label}</span>
        <span className="mono">{mimeType.split("/")[0]}</span>
      </div>
    </div>
  );
}
