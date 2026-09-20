'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

function cacheBustDisplayUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  const base = url.split('?')[0];
  if (!base) return null;
  return `${base}?t=${Date.now()}`;
}

interface ProfileState {
  name: string;
  picUrl: string | null;
  facultyId: number | null;
  hasCustomPhoto: boolean;
  updatePicUrl: (url: string | null, options?: { custom?: boolean }) => void;
}

const InstructorProfileContext = createContext<ProfileState>({
  name: '',
  picUrl: null,
  facultyId: null,
  hasCustomPhoto: false,
  updatePicUrl: () => {},
});

export function useInstructorProfile() {
  return useContext(InstructorProfileContext);
}

export function InstructorProfileProvider({ children }: { children: React.ReactNode }) {
  const [name, setName] = useState('');
  const [picUrl, setPicUrl] = useState<string | null>(null);
  const [facultyId, setFacultyId] = useState<number | null>(null);
  const [hasCustomPhoto, setHasCustomPhoto] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/auth/me', { signal: controller.signal })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.user) {
          setName(d.user.name || d.user.username || '');
          setFacultyId(d.user.faculty_id ?? null);
          setHasCustomPhoto(d.user.has_custom_profile_picture === true);
          setPicUrl(cacheBustDisplayUrl(d.user.profile_picture ?? null));
        }
      })
      .catch(e => { if (e?.name !== 'AbortError') console.error('[InstructorProfile]', e); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    function onPictureChanged(e: Event) {
      const detail = (e as CustomEvent<{
        picUrl?: string | null;
        hasCustom?: boolean;
      }>).detail ?? {};
      setPicUrl(cacheBustDisplayUrl(detail.picUrl ?? null));
      if (typeof detail.hasCustom === 'boolean') setHasCustomPhoto(detail.hasCustom);
    }
    window.addEventListener('profile-picture-changed', onPictureChanged);
    return () => window.removeEventListener('profile-picture-changed', onPictureChanged);
  }, []);

  const updatePicUrl = useCallback((url: string | null, options?: { custom?: boolean }) => {
    setPicUrl(cacheBustDisplayUrl(url));
    if (typeof options?.custom === 'boolean') setHasCustomPhoto(options.custom);
  }, []);

  const value = useMemo(
    () => ({ name, picUrl, facultyId, hasCustomPhoto, updatePicUrl }),
    [name, picUrl, facultyId, hasCustomPhoto, updatePicUrl]
  );

  return (
    <InstructorProfileContext.Provider value={value}>
      {children}
    </InstructorProfileContext.Provider>
  );
}
