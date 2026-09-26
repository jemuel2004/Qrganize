'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Upload, Trash2, X, CheckCircle, AlertTriangle } from 'lucide-react';
import ImageCropDialog from '@/client/components/ui/ImageCropDialog';

interface Props {
  currentUrl: string | null;
  uploadEndpoint: string;
  deleteEndpoint?: string;
  onSuccess: (url: string) => void;
  onRemove?: (nextDisplayUrl?: string | null) => void;
  theme?: 'light' | 'dark';
  maxSizeMB?: number;
  cropSize?: number;
  /** Compact horizontal strip: small avatar + buttons, no drag-drop zone */
  compact?: boolean;
  /** Shown beside the single avatar in compact mode */
  displayName?: string;
  /** When false, hide remove even if a display image (e.g. Google) is shown. */
  hasRemovablePhoto?: boolean;
  removeLabel?: string;
}

export function ProfilePictureUpload({
  currentUrl,
  uploadEndpoint,
  deleteEndpoint,
  onSuccess,
  onRemove,
  theme = 'light',
  maxSizeMB = 5,
  cropSize = 512,
  compact = false,
  displayName,
  hasRemovablePhoto,
  removeLabel = 'Remove Photo',
}: Props) {
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [cropFileName, setCropFileName] = useState('profile.jpg');
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const dark = theme === 'dark';

  useEffect(() => {
    return () => {
      if (cropSrc) URL.revokeObjectURL(cropSrc);
    };
  }, [cropSrc]);

  function clearCropSrc() {
    setCropSrc(prev => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }

  function processFile(file: File) {
    setError('');
    setSuccess('');
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.type)) {
      setError('Only JPG, PNG, or WebP images are allowed.');
      return;
    }
    if (file.size > maxSizeMB * 1024 * 1024) {
      setError(`File must be under ${maxSizeMB} MB.`);
      return;
    }
    clearCropSrc();
    setCropFileName(file.name || 'profile.jpg');
    setCropSrc(URL.createObjectURL(file));
  }

  function onFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) processFile(file);
  }

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) processFile(file);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function uploadCropped(file: File) {
    clearCropSrc();
    setUploading(true);
    setError('');
    setSuccess('');
    try {
      const fd = new FormData();
      fd.append('picture', file);
      const res = await fetch(uploadEndpoint, { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Upload failed.');
        return;
      }
      setSuccess('Profile picture updated!');
      onSuccess(data.picture_url);
      window.dispatchEvent(new CustomEvent('profile-picture-changed', {
        detail: { picUrl: data.picture_url, hasCustom: true },
      }));
    } catch {
      setError('Upload failed. Please try again.');
    } finally {
      setUploading(false);
    }
  }

  async function remove() {
    if (!deleteEndpoint || !onRemove) return;
    if (!window.confirm('Remove your custom profile picture?')) return;
    setRemoving(true);
    setError('');
    setSuccess('');
    try {
      const res = await fetch(deleteEndpoint, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Failed to remove.');
        return;
      }
      setSuccess('Custom profile picture removed.');
      const nextUrl = typeof data.picture_url === 'string' ? data.picture_url : null;
      onRemove(nextUrl);
      window.dispatchEvent(new CustomEvent('profile-picture-changed', {
        detail: { picUrl: nextUrl, hasCustom: false },
      }));
    } catch {
      setError('Failed to remove. Please try again.');
    } finally {
      setRemoving(false);
    }
  }

  const canRemove = (hasRemovablePhoto ?? Boolean(currentUrl)) && Boolean(deleteEndpoint) && Boolean(onRemove);

  const alertError = dark
    ? 'bg-red-500/8 border-red-500/25 text-red-300'
    : 'bg-red-50 border-red-200 text-red-600';
  const alertSuccess = dark
    ? 'bg-emerald-500/8 border-emerald-500/25 text-emerald-300'
    : 'bg-emerald-50 border-emerald-200 text-emerald-700';
  const avatarRing = dark ? 'border-4 border-white/[0.08] bg-slate-800' : 'border-4 border-[#E2E8F0] bg-[#F8FAFC]';
  const textMuted = dark ? 'text-slate-400' : 'text-[#64748B]';
  const textFaint = dark ? 'text-slate-500' : 'text-[#94A3B8]';
  const textName = dark ? 'text-white' : 'text-[#0B2A5B]';

  const feedback = (error || success) && (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs border mb-3 ${error ? alertError : alertSuccess}`}>
      {error
        ? <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
        : <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" />}
      <span className="flex-1 min-w-0 break-words">{error || success}</span>
      <button type="button" onClick={() => { setError(''); setSuccess(''); }} aria-label="Dismiss">
        <X className="w-3 h-3" />
      </button>
    </div>
  );

  const cropDialog = (
    <ImageCropDialog
      open={Boolean(cropSrc)}
      imageSrc={cropSrc || ''}
      fileName={cropFileName}
      outputSize={cropSize}
      theme={theme}
      title="Adjust Profile Photo"
      onCancel={clearCropSrc}
      onSave={file => { void uploadCropped(file); }}
    />
  );

  const fileInput = (
    <input
      ref={fileRef}
      type="file"
      accept="image/jpeg,image/png,image/webp"
      className="hidden"
      onChange={onFileInput}
    />
  );

  if (compact) {
    const spinnerCls = dark
      ? 'border-2 border-red-400/30 border-t-red-400'
      : 'border-2 border-red-300 border-t-red-600';

    return (
      <div>
        {feedback}
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <div className={`w-24 h-24 rounded-full overflow-hidden flex items-center justify-center flex-shrink-0 ${avatarRing}`}>
            {currentUrl
              ? // eslint-disable-next-line @next/next/no-img-element
                <img src={currentUrl} alt="Profile picture" className="w-full h-full object-cover" />
              : <Camera className={`w-8 h-8 ${textFaint}`} />}
          </div>

          <div className="flex-1 min-w-0 space-y-2">
            {displayName ? (
              <p className={`text-sm font-bold truncate ${textName}`}>{displayName}</p>
            ) : null}
            <p className={`text-xs ${textFaint}`}>
              JPG, PNG, or WebP · Max {maxSizeMB} MB
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                disabled={uploading}
                onClick={() => fileRef.current?.click()}
                className={dark
                  ? 'inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border border-white/[0.10] text-slate-300 hover:bg-white/[0.05] transition-colors disabled:opacity-50'
                  : 'inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-[#EFF6FF] hover:bg-[#DBEAFE] border border-[#BFDBFE] text-[#1D5BD6] transition-colors disabled:opacity-50'}
              >
                {uploading
                  ? <><div className="w-3.5 h-3.5 border-2 border-current/30 border-t-current rounded-full animate-spin" />Uploading…</>
                  : <><Camera className="w-3.5 h-3.5" />{currentUrl ? 'Change Photo' : 'Upload Photo'}</>}
              </button>

              {canRemove && (
                <button
                  type="button"
                  onClick={() => void remove()}
                  disabled={removing || uploading}
                  className={dark
                    ? 'inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border border-red-500/20 text-red-400 hover:bg-red-500/[0.08] transition-colors disabled:opacity-50'
                    : 'inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border border-red-200 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50'}
                >
                  {removing
                    ? <div className={`w-3.5 h-3.5 rounded-full animate-spin ${spinnerCls}`} />
                    : <Trash2 className="w-3.5 h-3.5" />}
                  {removing ? 'Removing…' : removeLabel}
                </button>
              )}
            </div>
          </div>
        </div>
        {fileInput}
        {cropDialog}
      </div>
    );
  }

  // Full layout
  return (
    <div className="space-y-4">
      {feedback}

      <div className="flex justify-center">
        <div className={`w-32 h-32 rounded-full overflow-hidden flex items-center justify-center ${avatarRing}`}>
          {currentUrl
            ? // eslint-disable-next-line @next/next/no-img-element
              <img src={currentUrl} alt="Profile" className="w-full h-full object-cover" />
            : <Camera className={`w-10 h-10 ${textFaint}`} />}
        </div>
      </div>

      <div
        className={dark
          ? 'border-2 border-dashed rounded-2xl flex flex-col items-center justify-center gap-3 p-6 cursor-pointer transition-all border-white/[0.10] hover:border-white/[0.20] hover:bg-white/[0.02]'
          : 'border-2 border-dashed rounded-2xl flex flex-col items-center justify-center gap-3 p-6 cursor-pointer transition-all border-[#CBD5E1] hover:border-[#1D5BD6]/60 hover:bg-[#F8FAFC]'}
        onDragOver={e => e.preventDefault()}
        onDrop={onDrop}
        onClick={() => !uploading && fileRef.current?.click()}
      >
        <Upload className={`w-8 h-8 ${textFaint}`} />
        <div className="text-center">
          <p className={`text-sm font-semibold ${textMuted}`}>
            {uploading ? 'Uploading…' : 'Drag & drop or click to upload'}
          </p>
          <p className={`text-xs mt-1 ${textFaint}`}>
            JPG · PNG · WebP · Max {maxSizeMB} MB · Crop before save
          </p>
        </div>
      </div>

      {canRemove && (
        <button
          type="button"
          onClick={() => void remove()}
          disabled={removing || uploading}
          className={dark
            ? 'w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium border transition-colors disabled:opacity-50 border-red-500/20 text-red-400 hover:bg-red-500/[0.08]'
            : 'w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium border transition-colors disabled:opacity-50 border-red-200 text-red-600 hover:bg-red-50'}
        >
          {removing
            ? <><div className="w-4 h-4 border-2 border-red-400/30 border-t-red-400 rounded-full animate-spin" />Removing…</>
            : <><Trash2 className="w-4 h-4" />{removeLabel}</>}
        </button>
      )}

      {fileInput}
      {cropDialog}
    </div>
  );
}
