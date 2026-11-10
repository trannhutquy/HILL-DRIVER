/* Service worker — Hill Driver PWA
 * Mỗi lần bạn đưa bản mới lên hosting, hãy đổi số VERSION để máy người dùng cập nhật.
 * - Trang chính + file của app : mở NGAY bằng bản đã lưu, cập nhật bản mới ở nền
 *   (mỗi lần phát hành đổi VERSION nên bản lưu luôn là bản mới nhất đã cài).
 * - Thư viện CDN (Leaflet, Chart.js, jsPDF, font...): lưu lại, lần sau mở nhanh/offline.
 * - Ô bản đồ (tile.openstreetmap.org): lưu lại, vùng đã xem lần sau hiện ngay, không cần tải lại.
 * - Lệnh gọi API Apps Script (POST), tìm địa chỉ, đường đi, thời tiết, QR: KHÔNG can thiệp, luôn đi thẳng ra mạng.
 */
const VERSION = 'v13';
const SHELL_CACHE = 'hd-shell-' + VERSION;
const CDN_CACHE = 'hd-cdn-' + VERSION;
const TILE_CACHE = 'hd-tiles-v1'; // không gắn VERSION: ô bản đồ ít đổi, không cần xoá mỗi lần cập nhật app
const TILE_MAX = 500;
const SHELL_FILES = [
  './', './index.html', './config.js', './gas-shim.js', './pwa.js',
  './manifest.webmanifest',
  './assets/favicon.png',
  './assets/logo-light.png', './assets/logo-dark.png',
  './assets/logo-icon-light.png', './assets/logo-icon-dark.png',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'
];
const CDN_HOSTS = ['unpkg.com', 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

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

// Trang chính + file của app: MỞ NGAY bằng bản đã lưu (nếu có) và tải bản mới ở nền cho lần sau.
// An toàn vì mỗi lần phát hành đều đổi VERSION -> service worker mới tải sẵn bộ file mới
// vào một cache mới, nên bản đã lưu luôn cùng phiên bản với nhau (không bị lẫn index.html cũ
// với gas-shim.js mới).
// Lần đầu (chưa có cache) hoặc mất mạng mà chưa lưu: vẫn chờ mạng như bình thường.
function shellFirst(request, cacheKey) {
  return caches.open(SHELL_CACHE).then(function (cache) {
    var key = cacheKey || request;

    // Vào app có thể bằng "/", "/index.html" hoặc URL kèm ?query -> tìm bản đã lưu ở cả các dạng đó.
    var lookupKeys = [key];
    if (request.mode === 'navigate') lookupKeys.push('./index.html', './');

    function matchAny(i) {
      if (i >= lookupKeys.length) return Promise.resolve(null);
      return cache.match(lookupKeys[i], { ignoreSearch: true }).then(function (hit) {
        return hit || matchAny(i + 1);
      });
    }

    var network = fetch(request).then(function (res) {
      if (res && res.ok) cache.put(key, res.clone());
      return res;
    });

    return matchAny(0).then(function (cached) {
      if (cached) {
        network.catch(function () {}); // cập nhật nền, lỗi thì dùng tiếp bản đã lưu
        return cached;
      }
      return network;
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
      event.respondWith(shellFirst(req, './index.html'));
    } else {
      event.respondWith(shellFirst(req, null));
    }
    return;
  }
  if (/(^|\.)(tile\.openstreetmap\.org|tile\.openstreetmap\.de|tile\.openstreetmap\.fr)$/.test(url.hostname)) {
    event.respondWith(tileFirst(event));
    return;
  }
  if (CDN_HOSTS.indexOf(url.hostname) !== -1) {
    event.respondWith(cacheFirst(req));
  }
  // Các domain khác (script.google.com, nominatim, osrm, open-meteo, vietqr...) : không xử lý.
});
