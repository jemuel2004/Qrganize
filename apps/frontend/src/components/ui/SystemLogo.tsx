'use client';

import { useEffect, useRef } from 'react';
import { useSystemLogo } from '@/hooks/useSystemLogo';
import { drawImageSmooth } from '@/lib/drawImageSmooth';

interface SystemLogoProps {
  /** Display size in CSS pixels. Default 44. */
  size?: number;
  className?: string;
}

/**
 * Instagram-style circular logo, painted at the screen's real pixel density
 * so it stays sharp on Windows display scaling.
 */
export default function SystemLogo({ size = 44, className = '' }: SystemLogoProps) {
  const logoUrl = useSystemLogo();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!logoUrl) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (cancelled || !canvasRef.current) return;
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      const px = Math.max(1, Math.round(size * dpr));
      canvas.width = px;
      canvas.height = px;
      canvas.style.width = `${size}px`;
      canvas.style.height = `${size}px`;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, px, px);

      const iw = img.naturalWidth;
      const ih = img.naturalHeight;
      if (!iw || !ih) return;

      const scale = Math.max(px / iw, px / ih);
      const dw = iw * scale;
      const dh = ih * scale;
      const dx = (px - dw) / 2;
      const dy = (px - dh) / 2;

      ctx.save();
      ctx.beginPath();
      ctx.arc(px / 2, px / 2, px / 2, 0, Math.PI * 2);
      ctx.clip();
      drawImageSmooth(ctx, img, 0, 0, iw, ih, dx, dy, dw, dh);
      ctx.restore();
    };
    img.src = logoUrl;

    return () => {
      cancelled = true;
    };
  }, [logoUrl, size]);

  if (!logoUrl) return null;

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label="System logo"
      className={className}
      style={{
        width: size,
        height: size,
        display: 'block',
        flexShrink: 0,
        borderRadius: '50%',
      }}
    />
  );
}
