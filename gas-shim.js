/*
 * Lớp chuyển đổi: giả lập google.script.run của Apps Script bằng fetch().
 * Nhờ vậy toàn bộ code giao diện cũ (khoảng 50 chỗ gọi google.script.run...)
 * chạy tiếp mà KHÔNG phải sửa. Mọi lệnh gọi được gửi tới Web App Apps Script
 * dưới dạng POST JSON: { fn: "tenHam", args: [...] }.
 *
 * BẢN TĂNG TỐC:
 *  1) Các lệnh gọi phát ra cùng lúc (vd lúc vào app) được GỘP thành 1 request -> chỉ chờ Apps Script 1 lần.
 *  2) Tìm địa chỉ / gợi ý / định vị ngược / tính đường đi / thời tiết được gọi TRỰC TIẾP từ điện thoại
 *     (Nominatim, OSRM, Open-Meteo), chạy song song, không đi vòng qua Apps Script nữa.
 *     Nếu gọi trực tiếp lỗi (mạng yếu, bị giới hạn...) sẽ tự quay về cách cũ qua Apps Script.
 *  3) Tự "đánh thức" Apps Script khi mở lại app sau một lúc không dùng.
 */
(function () {
  'use strict';
  var CFG = window.HD_CONFIG || {};
  var TIMEOUT_MS = 60000;      // Apps Script đôi khi phản hồi chậm (khởi động lạnh)
  var DIRECT_TIMEOUT_MS = 9000; // gọi trực tiếp dịch vụ bản đồ: quá 9s thì quay về cách cũ

  var NOMINATIM = 'https://nominatim.openstreetmap.org';
  // Dịch vụ dự phòng: Photon (komoot) cũng dùng dữ liệu OpenStreetMap nhưng
  // được thiết kế cho tìm kiếm/gợi ý địa chỉ, có CORS cho trình duyệt và ít bị
  // chặn hơn Nominatim. Dùng khi Nominatim báo bận/chặn (HTTP 403, 429...).
  var PHOTON = 'https://photon.komoot.io';
  var OSRM = 'https://router.project-osrm.org';
  var METEO = 'https://api.open-meteo.com/v1/forecast';
  // Bán kính ưu tiên (không phải giới hạn cứng): địa chỉ quanh vị trí hiện tại
  // được xếp hạng trước, nhưng điểm đến ở xa vẫn tìm thấy (trước đây dùng
  // bounded=1 nên địa chỉ ngoài 20km biến mất khỏi danh sách gợi ý).
  var SUGGEST_RADIUS_KM = 20;
  var GEOCODE_BIAS_RADIUS_KM = 50; // ưu tiên nhẹ quanh điểm đi khi tìm toạ độ điểm đến
  var NOMINATIM_BLOCK_MS = 10 * 60 * 1000; // Nominatim lỗi -> tạm dùng Photon 10 phút
  var nominatimBlockedUntil = 0;

  var lastApiAt = Date.now();

  // ------------------------------------------------------------------
  // 1) GỌI APPS SCRIPT (có gộp request)
  // ------------------------------------------------------------------
  function postRaw(payload) {
    var url = CFG.API_URL;
    if (!url || /PASTE_|XXXX/.test(url)) {
      return Promise.reject(new Error('Chưa cấu hình API_URL trong file config.js.'));
    }
    if (navigator.onLine === false) {
      return Promise.reject(new Error('Không có kết nối mạng. Vui lòng kiểm tra Wi-Fi/4G rồi thử lại.'));
    }
    var ctrl = ('AbortController' in window) ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS) : null;
    lastApiAt = Date.now();

    // Dùng text/plain để trình duyệt coi là "simple request" -> KHÔNG bị preflight CORS
    // (Apps Script không xử lý được preflight OPTIONS).
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow',
      cache: 'no-store',
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (timer) clearTimeout(timer);
      if (!res.ok) throw new Error('Máy chủ trả về lỗi HTTP ' + res.status + '.');
      return res.text();
    }).then(function (text) {
      var json;
      try { json = JSON.parse(text); } catch (e) {
        throw new Error('Máy chủ trả dữ liệu không hợp lệ. Hãy kiểm tra Web App đã triển khai với quyền truy cập "Bất kỳ ai" (Anyone).');
      }
      return json;
    }).catch(function (err) {
      if (timer) clearTimeout(timer);
      if (err && err.name === 'AbortError') throw new Error('Máy chủ phản hồi quá lâu. Vui lòng thử lại.');
      if (err instanceof TypeError) throw new Error('Không kết nối được máy chủ. Kiểm tra mạng hoặc quyền truy cập của Web App.');
      throw err;
    });
  }

  // Các lệnh gọi trong CÙNG 1 nhịp (vd enterApp gọi 8 hàm liền) được gom thành 1 request.
  var queue = [];
  var flushTimer = null;

  function flush() {
    var items = queue;
    queue = [];
    flushTimer = null;
    if (!items.length) return;

    if (items.length === 1) {
      var one = items[0];
      postRaw({ fn: one.fn, args: one.args }).then(function (json) {
        if (!json || json.ok !== true) throw new Error((json && json.error) || 'Lỗi máy chủ.');
        one.resolve(json.result);
      }).catch(one.reject);
      return;
    }

    postRaw({ batch: items.map(function (it) { return { fn: it.fn, args: it.args }; }) }).then(function (json) {
      if (json && json.ok === true && Array.isArray(json.results)) {
        items.forEach(function (it, i) {
          var r = json.results[i];
          if (r && r.ok === true) it.resolve(r.result);
          else it.reject(new Error((r && r.error) || 'Lỗi máy chủ.'));
        });
        return;
      }
      // Máy chủ chưa cập nhật Code.gs (không hiểu "batch") -> gửi lẻ từng lệnh như cũ
      items.forEach(function (it) {
        postRaw({ fn: it.fn, args: it.args }).then(function (j) {
          if (!j || j.ok !== true) throw new Error((j && j.error) || 'Lỗi máy chủ.');
          it.resolve(j.result);
        }).catch(it.reject);
      });
    }).catch(function (err) {
      items.forEach(function (it) { it.reject(err); });
    });
  }

  function callApi(fn, args) {
    return new Promise(function (resolve, reject) {
      queue.push({ fn: fn, args: args || [], resolve: resolve, reject: reject });
      if (!flushTimer) flushTimer = setTimeout(flush, 0);
    });
  }

  // ------------------------------------------------------------------
  // 2) GỌI TRỰC TIẾP DỊCH VỤ BẢN ĐỒ TỪ TRÌNH DUYỆT
  // ------------------------------------------------------------------
  function fetchJson(url, timeoutMs) {
    var ctrl = ('AbortController' in window) ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs || DIRECT_TIMEOUT_MS) : null;
    return fetch(url, { signal: ctrl ? ctrl.signal : undefined, credentials: 'omit' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (j) { if (timer) clearTimeout(timer); return j; },
            function (e) { if (timer) clearTimeout(timer); throw e; });
  }

  // Cache nhỏ trong bộ nhớ + localStorage (6 giờ) để gõ lại / bấm lại cùng địa chỉ là có ngay
  var MEM = {};
  var LS_PREFIX = 'hdc:';
  var CACHE_TTL = 6 * 3600 * 1000;
  var LS_MAX = 120;
  function cacheGet(key) {
    var m = MEM[key];
    if (m && Date.now() - m.t < CACHE_TTL) return m.v;
    try {
      var raw = localStorage.getItem(LS_PREFIX + key);
      if (raw) {
        var o = JSON.parse(raw);
        if (o && Date.now() - o.t < CACHE_TTL) { MEM[key] = o; return o.v; }
        localStorage.removeItem(LS_PREFIX + key);
      }
    } catch (e) {}
    return null;
  }
  function cachePut(key, v) {
    var o = { t: Date.now(), v: v };
    MEM[key] = o;
    try {
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(LS_PREFIX) === 0) keys.push(k);
      }
      if (keys.length >= LS_MAX) {
        keys.sort(function (a, b) {
          var ta = 0, tb = 0;
          try { ta = JSON.parse(localStorage.getItem(a)).t; } catch (e) {}
          try { tb = JSON.parse(localStorage.getItem(b)).t; } catch (e) {}
          return ta - tb;
        });
        for (var j = 0; j < 30 && j < keys.length; j++) localStorage.removeItem(keys[j]);
      }
      localStorage.setItem(LS_PREFIX + key, JSON.stringify(o));
    } catch (e) {}
  }
  function normText(t) { return String(t || '').trim().toLowerCase().replace(/\s+/g, ' '); }

  function viewbox(lat, lng, radiusKm) {
    var latDelta = radiusKm / 111;
    var cosLat = Math.cos(lat * Math.PI / 180);
    var lngDelta = radiusKm / (111 * (Math.abs(cosLat) > 0.01 ? Math.abs(cosLat) : 0.01));
    return (lng - lngDelta) + ',' + (lat + latDelta) + ',' + (lng + lngDelta) + ',' + (lat - latDelta);
  }

  // ------------------------------------------------------------------
  // DỰ PHÒNG PHOTON: cùng dữ liệu OpenStreetMap, trả kết quả đúng dạng
  // { lat, lng, displayName } như Nominatim để phần còn lại không phải sửa.
  // ------------------------------------------------------------------
  function nominatimBlocked() { return Date.now() < nominatimBlockedUntil; }
  function markNominatimBlocked() { nominatimBlockedUntil = Date.now() + NOMINATIM_BLOCK_MS; }

  // Photon đôi khi trả 503/429 khi có nhiều yêu cầu dồn dập -> thử lại tối đa
  // 3 lần (chờ 0,8s rồi 1,8s) thay vì báo lỗi ngay.
  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }
  function photonFetch(url) {
    var attemptNo = 0;
    function attempt() {
      attemptNo++;
      return fetchJson(url).catch(function (err) {
        if (attemptNo >= 3) throw err;
        return delay(attemptNo === 1 ? 800 : 1800).then(attempt);
      });
    }
    return attempt();
  }

  function photonDisplayName(p) {
    p = p || {};
    var parts = [];
    function add(v) {
      v = String(v || '').trim();
      if (v && parts.indexOf(v) === -1) parts.push(v);
    }
    var street = String(p.street || '').trim();
    var house = String(p.housenumber || '').trim();
    if (house && street && street.indexOf(house) === -1) street = house + ' ' + street;
    else if (house && !street) street = house;
    if (!street) street = String(p.name || '').trim();
    add(street);
    add(p.locality);
    add(p.district);
    add(p.city);
    add(p.state);
    add(p.country);
    return parts.join(', ');
  }

  function photonSearch(query, nearLat, nearLng, limit) {
    var url = PHOTON + '/api/?q=' + encodeURIComponent(query) + '&limit=' + (limit || 6);
    var lat = Number(nearLat), lng = Number(nearLng);
    if (!isNaN(lat) && !isNaN(lng) && Math.abs(lat) > 0.0001 && Math.abs(lng) > 0.0001) {
      url += '&lat=' + lat + '&lon=' + lng;
    }
    return photonFetch(url).then(function(j) {
      var feats = (j && j.features) || [];
      return feats.map(function(f) {
        var c = (f.geometry && f.geometry.coordinates) || [];
        return { lat: Number(c[1]), lng: Number(c[0]), displayName: photonDisplayName(f.properties) };
      }).filter(function(it) { return !isNaN(it.lat) && !isNaN(it.lng) && it.displayName; });
    });
  }

  function photonReverse(lat, lng) {
    var url = PHOTON + '/reverse?lon=' + lng + '&lat=' + lat + '&limit=1';
    return photonFetch(url).then(function(j) {
      var feats = (j && j.features) || [];
      if (!feats.length) return '';
      return photonDisplayName(feats[0].properties);
    });
  }

  // Giải mã polyline (độ chính xác 5 chữ số) của OSRM -> [[lat,lng], ...]
  function decodePolyline(str) {
    var index = 0, lat = 0, lng = 0, out = [];
    while (index < str.length) {
      var b, shift = 0, result = 0;
      do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lat += (result & 1) ? ~(result >> 1) : (result >> 1);
      shift = 0; result = 0;
      do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      lng += (result & 1) ? ~(result >> 1) : (result >> 1);
      out.push([lat / 1e5, lng / 1e5]);
    }
    return out;
  }

  var DIRECT = {};

  // Gợi ý địa chỉ khi gõ
  DIRECT.searchAddressSuggestions = function (query, nearLat, nearLng) {
    query = String(query || '').trim();
    if (!query || query.length < 3) return Promise.resolve({ success: true, items: [] });
    // accept-language=vi: trả tên đường/phường/tỉnh bằng tiếng Việt (trước đây có
    // thể trả "Vietnam", tên tiếng Anh hoặc tên phiên âm -> nhìn như sai địa chỉ).
    var url = NOMINATIM + '/search?format=json&addressdetails=1&accept-language=vi&limit=6&countrycodes=vn&q=' + encodeURIComponent(query);
    var keyRaw = normText(query);
    var lat = Number(nearLat), lng = Number(nearLng);
    if (!isNaN(lat) && !isNaN(lng) && Math.abs(lat) > 0.0001 && Math.abs(lng) > 0.0001) {
      // viewbox KHÔNG kèm bounded=1: chỉ ưu tiên khu vực đang đứng, không loại bỏ
      // địa chỉ ở tỉnh/thành khác (điểm đến xa vẫn gợi ý được).
      url += '&viewbox=' + viewbox(lat, lng, SUGGEST_RADIUS_KM);
      keyRaw += '|' + lat.toFixed(2) + ',' + lng.toFixed(2);
    }
    var key = 'sg:' + keyRaw;
    var hit = cacheGet(key);
    if (hit) return Promise.resolve({ success: true, items: hit });

    function viaNominatim() {
      return fetchJson(url).then(function (arr) {
        if (!Array.isArray(arr)) throw new Error('bad');
        return arr.map(function (it) { return { lat: parseFloat(it.lat), lng: parseFloat(it.lon), displayName: it.display_name }; });
      });
    }
    function viaPhoton() { return photonSearch(query, lat, lng, 6); }

    // Nominatim lỗi/chặn -> tự chuyển Photon; Nominatim không có kết quả -> thử Photon.
    var p;
    if (nominatimBlocked()) {
      p = viaPhoton();
    } else {
      p = viaNominatim()
        .catch(function () { markNominatimBlocked(); return []; })
        .then(function (items) { return (items && items.length) ? items : viaPhoton(); });
    }
    return p.then(function (items) {
      cachePut(key, items);
      return { success: true, items: items };
    });
  };

  // Địa chỉ chữ -> toạ độ
  // nearLat/nearLng (không bắt buộc): vị trí để ưu tiên khi tên đường/địa chỉ
  // trùng ở nhiều tỉnh/thành. Chỉ là ưu tiên nhẹ (không giới hạn cứng).
  DIRECT.geocodeAddress = function (address, nearLat, nearLng) {
    if (!address) return Promise.resolve({ success: false, message: 'Địa chỉ trống.' });
    var lat = Number(nearLat), lng = Number(nearLng);
    var hasNear = !isNaN(lat) && !isNaN(lng) && Math.abs(lat) > 0.0001 && Math.abs(lng) > 0.0001;
    var key = 'geo:' + normText(address) + (hasNear ? '|' + lat.toFixed(2) + ',' + lng.toFixed(2) : '');
    var hit = cacheGet(key);
    if (hit) return Promise.resolve(hit);
    var url = NOMINATIM + '/search?format=json&addressdetails=1&accept-language=vi&limit=1&countrycodes=vn&q=' + encodeURIComponent(address);
    if (hasNear) url += '&viewbox=' + viewbox(lat, lng, GEOCODE_BIAS_RADIUS_KM);

    function viaNominatim() {
      return fetchJson(url).then(function (json) {
        if (!Array.isArray(json)) throw new Error('bad');
        if (json.length === 0) return null;
        return { lat: parseFloat(json[0].lat), lng: parseFloat(json[0].lon), displayName: json[0].display_name };
      });
    }
    function viaPhoton() {
      return photonSearch(address, lat, lng, 5).then(function (items) { return items.length ? items[0] : null; });
    }

    // Nominatim bận/chặn hoặc không có kết quả -> thử Photon trước khi báo lỗi.
    var p;
    if (nominatimBlocked()) {
      p = viaPhoton();
    } else {
      p = viaNominatim()
        .catch(function () { markNominatimBlocked(); return null; })
        .then(function (first) { return first || viaPhoton(); });
    }
    return p.then(function (first) {
      if (!first) {
        return { success: false, message: 'Không tìm thấy địa chỉ "' + address + '". Hãy nhập rõ hơn (số nhà, đường, phường/xã, quận/huyện, tỉnh/thành) hoặc dùng nút "Lấy vị trí hiện tại".' };
      }
      var res = { success: true, lat: first.lat, lng: first.lng, displayName: first.displayName };
      cachePut(key, res);
      return res;
    });
  };

  // Toạ độ -> địa chỉ chữ
  DIRECT.reverseGeocode = function (lat, lng) {
    lat = Number(lat); lng = Number(lng);
    var key = 'rev:' + lat.toFixed(4) + ',' + lng.toFixed(4);
    var hit = cacheGet(key);
    if (hit) return Promise.resolve(hit);
    // accept-language=vi + zoom=18: lấy địa chỉ chi tiết nhất (tới đường/số nhà
    // nếu OpenStreetMap có dữ liệu) và hiển thị bằng tiếng Việt.
    var url = NOMINATIM + '/reverse?format=json&addressdetails=1&accept-language=vi&zoom=18&lat=' + lat + '&lon=' + lng;

    function viaNominatim() {
      return fetchJson(url).then(function (json) {
        if (!json || json.error) throw new Error('bad');
        return json.display_name || '';
      });
    }
    function viaPhoton() { return photonReverse(lat, lng); }

    var p;
    if (nominatimBlocked()) {
      p = viaPhoton();
    } else {
      p = viaNominatim()
        .catch(function () { markNominatimBlocked(); return ''; })
        .then(function (name) { return name || viaPhoton(); });
    }
    return p.then(function (name) {
      var res = { success: true, displayName: name || (lat.toFixed(6) + ', ' + lng.toFixed(6)) };
      cachePut(key, res);
      return res;
    });
  };

  function osrmRoute(oLat, oLng, dLat, dLng) {
    var url = OSRM + '/route/v1/driving/' + oLng + ',' + oLat + ';' + dLng + ',' + dLat + '?overview=full&geometries=polyline';
    return fetchJson(url, 12000).then(function (json) {
      if (!json || json.code !== 'Ok' || !json.routes || !json.routes.length) throw new Error('no route');
      var r = json.routes[0];
      return { distanceKm: r.distance / 1000, durationMin: r.duration / 60, path: decodePolyline(r.geometry) };
    });
  }

  // Thời tiết hiện tại tại 1 điểm; lỗi/quá 4 giây -> null (server coi như không mưa, giống hành vi cũ)
  function weatherAt(lat, lng) {
    var url = METEO + '?latitude=' + lat + '&longitude=' + lng + '&current=precipitation,weather_code&timezone=auto';
    return fetchJson(url, 4000).then(function (j) {
      var c = j && j.current;
      if (!c) return null;
      return { code: Number(c.weather_code), precipitation: Number(c.precipitation || 0) };
    }).catch(function () { return null; });
  }

  // Tính tiền: đường đi + thời tiết 2 đầu chạy SONG SONG ngay trên điện thoại,
  // rồi gửi lên Apps Script đúng 1 lần để áp bảng giá / phụ thu.
  DIRECT.calculateFare = function (oLat, oLng, oLabel, dLat, dLng, dLabel, username) {
    oLat = Number(oLat); oLng = Number(oLng); dLat = Number(dLat); dLng = Number(dLng);
    if (isNaN(oLat) || isNaN(oLng) || isNaN(dLat) || isNaN(dLng)) return Promise.reject(new Error('toạ độ lỗi'));
    return Promise.all([osrmRoute(oLat, oLng, dLat, dLng), weatherAt(oLat, oLng), weatherAt(dLat, dLng)])
      .then(function (r) {
        var route = r[0];
        var hint = { origin: r[1], dest: r[2] };
        return callApi('calculateFareFast', [oLat, oLng, oLabel, dLat, dLng, dLabel, username, route.distanceKm, route.durationMin, hint])
          .then(function (res) {
            if (res && res.success) { res.path = route.path; return res; }
            if (res && res.code === 'BAD_DISTANCE') throw new Error('bad distance'); // -> server tự tính như cũ
            return res; // lỗi nghiệp vụ khác: trả nguyên cho giao diện hiển thị
          });
      });
  };

  function run(prop, args) {
    var d = DIRECT[prop];
    if (!d) return callApi(prop, args);
    var p;
    try { p = d.apply(null, args); } catch (e) { p = Promise.reject(e); }
    return p.catch(function (err) {
      // Gọi trực tiếp lỗi (mạng yếu, bị giới hạn, server cũ chưa có calculateFareFast...) -> quay về cách cũ
      if (window.console) console.warn('[direct→server]', prop, err && err.message);
      return callApi(prop, args);
    });
  }

  function makeRunner(onOk, onFail) {
    return new Proxy({}, {
      get: function (_, prop) {
        if (prop === 'withSuccessHandler') return function (fn) { return makeRunner(fn, onFail); };
        if (prop === 'withFailureHandler') return function (fn) { return makeRunner(onOk, fn); };
        if (prop === 'withUserObject') return function () { return makeRunner(onOk, onFail); };
        if (typeof prop !== 'string') return undefined;
        return function () {
          var args = Array.prototype.slice.call(arguments);
          run(prop, args).then(
            function (result) { if (onOk) onOk(result); },
            function (err) { if (onFail) onFail(err); else console.error('[API]', prop, err); }
          );
        };
      }
    });
  }

  // ------------------------------------------------------------------
  // 3) ĐÁNH THỨC APPS SCRIPT khi mở lại app sau >4 phút không dùng
  // ------------------------------------------------------------------
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && Date.now() - lastApiAt > 4 * 60 * 1000) {
      callApi('ping', []).catch(function () {});
    }
  });

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = makeRunner(null, null);
  window.__hdCallApi = function (fn, args) { return run(fn, args || []); }; // thử trong Console: __hdCallApi('getRainManualOverride', [])
  window.__hdCallServer = callApi; // ép đi qua Apps Script để so sánh tốc độ
})();
