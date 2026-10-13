import type { MetadataRoute } from 'next';

/**
 * Lets phones add QRganize to the Home Screen as an app. iPhone and iPad
 * deliver class reminders (Web Push) only to a QRganize opened that way.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'QRganize',
    short_name: 'QRganize',
    description: 'QR-powered room booking, faculty workload tracking, and program scheduling',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#FFFFFF',
    theme_color: '#12408F',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}
