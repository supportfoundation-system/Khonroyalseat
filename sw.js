/* Service worker: ให้แอปเปิดได้แม้เน็ตหลุด
   - ไฟล์ของแอป: ดึงใหม่จากเน็ตก่อน (ได้เวอร์ชันล่าสุดเสมอ) ถ้าไม่มีเน็ตใช้ที่เก็บไว้
   - ไลบรารี/ฟอนต์จาก CDN: ใช้ที่เก็บไว้ แล้วอัปเดตเบื้องหลัง
   - ข้อมูลจาก Supabase: ไม่ผ่าน service worker (แอปจัดการเอง) */
const CACHE = 'royal-app-v4';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'importer.js', 'config.js', 'manifest.webmanifest',
  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'favicon-64.png'];
const CDN = /^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (url.pathname.endsWith('/version.json')) return;            // ให้เช็กเวอร์ชันจากเน็ตจริงเสมอ
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))));
    return;
  }
  if (CDN.test(req.url)) {
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req);
      const net = fetch(req).then((res) => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
  }
});
