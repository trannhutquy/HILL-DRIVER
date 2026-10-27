/* Service worker — Hill Driver PWA
 * Mỗi lần bạn đưa bản mới lên hosting, hãy đổi số VERSION để máy người dùng cập nhật.
 * - Trang chính + file của app : ưu tiên mạng (luôn mới), mất mạng thì dùng bản đã lưu.
 * - Thư viện CDN (Leaflet, Chart.js, jsPDF, font...): lưu lại, lần sau mở nhanh/offline.
 * - Ô bản đồ (tile.openstreetmap.org): lưu lại, vùng đã xem lần sau hiện ngay, không cần tải lại.
 * - Lệnh gọi API Apps Script (POST), tìm địa chỉ, đường đi, thời tiết, QR: KHÔNG can thiệp, luôn đi thẳng ra mạng.
 */
const VERSION = 'v2';
const SHELL_CACHE = 'hd-shell-' + VERSION;
const CDN_CACHE = 'hd-cdn-' + VERSION;
const TILE_CACHE = 'hd-tiles-v1'; // không gắn VERSION: ô bản đồ ít đổi, không cần xoá mỗi lần cập nhật app
const TILE_MAX = 500;
const SHELL_FILES = [
  './', './index.html', './config.js', './gas-shim.js', './pwa.js',
  './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'
];
const CDN_HOSTS = ['unpkg.com', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(function (c) { return c.addAll(SHELL_FILES); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys
        .filter(function (k) { return k !== SHELL_CACHE && k !== CDN_CACHE && k !== TILE_CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function networkFirst(request, cacheKey, timeoutMs) {
  return caches.open(SHELL_CACHE).then(function (cache) {
    var network = fetch(request).then(function (res) {
      if (res && res.ok) cache.put(cacheKey || request, res.clone());
      return res;
    });
    return cache.match(cacheKey || request, { ignoreSearch: true }).then(function (cached) {
      if (!cached) return network;
      var fallback = network.catch(function () { return cached; });
      var timeout = new Promise(function (resolve) { setTimeout(function () { resolve(cached); }, timeoutMs); });
      return Promise.race([fallback, timeout]);
    });
  });
}

function cacheFirst(request) {
  return caches.open(CDN_CACHE).then(function (cache) {
    return cache.match(request).then(function (hit) {
      if (hit) return hit;
      return fetch(request).then(function (res) {
        if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
        return res;
      });
    });
  });
}

function trimCache(cache, max) {
  return cache.keys().then(function (keys) {
    if (keys.length <= max) return;
    return Promise.all(keys.slice(0, keys.length - max).map(function (k) { return cache.delete(k); }));
  });
}

// Ô bản đồ: ưu tiên bản đã lưu. Tải lại bằng CORS để lưu được kích thước thật (không bị tính "opaque" nặng).
function tileFirst(event) {
  var req = event.request;
  return caches.open(TILE_CACHE).then(function (cache) {
    return cache.match(req.url).then(function (hit) {
      if (hit) return hit;
      return fetch(req.url, { mode: 'cors', credentials: 'omit' }).then(function (res) {
        if (res && res.ok) {
          cache.put(req.url, res.clone()).then(function () { return trimCache(cache, TILE_MAX); });
        }
        return res;
      }).catch(function () { return fetch(req); });
    });
  });
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return; // POST tới Apps Script đi thẳng ra mạng
  var url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate') {
      event.respondWith(networkFirst(req, './index.html', 3000));
    } else {
      event.respondWith(networkFirst(req, null, 3000));
    }
    return;
  }
  if (/(^|\.)tile\.openstreetmap\.org$/.test(url.hostname)) {
    event.respondWith(tileFirst(event));
    return;
  }
  if (CDN_HOSTS.indexOf(url.hostname) !== -1) {
    event.respondWith(cacheFirst(req));
  }
  // Các domain khác (script.google.com, nominatim, osrm, open-meteo, vietqr...) : không xử lý.
});
