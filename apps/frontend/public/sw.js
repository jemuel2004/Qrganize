/*
 * QRganize service worker. It only shows the class reminders the server sends
 * (Web Push) — also when QRganize is closed — and opens QRganize when one is
 * tapped. It caches nothing: pages and data always come from the network.
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/** "starts in 15 minutes" / "starts in 1 minute" / "starts now" */
function startsIn(minutes) {
  if (minutes <= 0) return 'starts now';
  return 'starts in ' + minutes + ' minute' + (minutes === 1 ? '' : 's');
}

/** The text, with the minutes counted again now (a push can arrive a little late) */
function bodyOf(data) {
  const body = typeof data.body === 'string' ? data.body : '';
  if (data.kind !== 'class' || typeof data.startsAt !== 'number' || typeof data.subject !== 'string') return body;
  const lines = body.split('\n');
  lines[0] = 'Your ' + data.subject + ' class ' + startsIn(Math.ceil((data.startsAt - Date.now()) / 60000)) + '.';
  return lines.join('\n');
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  if (!data || typeof data !== 'object') data = {};
  const title = typeof data.title === 'string' && data.title ? data.title : 'QRganize';
  const options = {
    body: bodyOf(data),
    icon: typeof data.icon === 'string' ? data.icon : '/icons/icon-192.png',
    // The same class time replaces its notification instead of adding another
    tag: typeof data.tag === 'string' ? data.tag : undefined,
    data: { url: typeof data.url === 'string' ? data.url : '/instructor' },
    timestamp: Date.now(),
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const wanted = (event.notification.data && event.notification.data.url) || '/instructor';
  const target = new URL(wanted, self.location.origin);
  // Only ever QRganize's own pages
  if (target.origin !== self.location.origin) return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== target.origin) continue;
      await client.focus();
      if ('navigate' in client) {
        try { await client.navigate(target.href); } catch { /* a tab this worker does not control */ }
      }
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});

/* The browser renewed this device's subscription: tell QRganize the new one */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const old = event.oldSubscription;
    const key = old && old.options ? old.options.applicationServerKey : null;
    if (!key) return;
    const fresh = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const send = (method, body) => fetch('/api/instructor/class-reminders/devices', {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await send('POST', fresh.toJSON());
    await send('DELETE', { endpoint: old.endpoint });
  })().catch(() => { /* QRganize re-checks this device the next time it opens */ }));
});
