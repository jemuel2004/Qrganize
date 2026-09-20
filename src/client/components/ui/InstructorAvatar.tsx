'use client';

import { useEffect, useState } from 'react';
import { getProfileInitials } from '@/lib/instructorAvatar';

type Props = {
  src: string | null | undefined;
  name: string;
  size?: number;
  className?: string;
  roundedClass?: string;
  alt?: string;
};

/**
 * Single Instructor avatar renderer: custom/Google image, else initials.
 * Broken or blocked image URLs fall back to the system default initials.
 */
export default function InstructorAvatar({
  src,
  name,
  size = 36,
  className = '',
  roundedClass = 'rounded-full',
  alt,
}: Props) {
  const [failed, setFailed] = useState(false);
  const initials = getProfileInitials(name || 'Instructor');
  const showImg = Boolean(src) && !failed;

  useEffect(() => {
    setFailed(false);
  }, [src]);

  const box = { width: size, height: size };

  if (showImg) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src as string}
        alt={alt || name || 'Profile picture'}
        onError={() => setFailed(true)}
        className={`flex-shrink-0 ${roundedClass} object-cover ${className}`}
        style={box}
        referrerPolicy="no-referrer"
      />
    );
  }

  return (
    <div
      className={`flex-shrink-0 ${roundedClass} bg-[#10B981] flex items-center justify-center font-bold text-white select-none ${className}`}
      style={{ ...box, fontSize: Math.max(10, size * 0.38) }}
      aria-hidden="true"
    >
      {initials}
    </div>
  );
}
