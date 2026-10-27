/* Đăng ký service worker + nút "Cài app" (Android/PC) + gợi ý cài trên iPhone. */
(function () {
  'use strict';

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function (e) { console.warn('SW lỗi:', e); });
    });
  }

  var DISMISS_KEY = 'hd_install_dismissed_at';
  var DAYS = 14;
  function dismissedRecently() {
    try {
      var t = Number(localStorage.getItem(DISMISS_KEY) || 0);
      return t && (Date.now() - t) < DAYS * 86400000;
    } catch (e) { return false; }
  }
  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  var pill = null;
  function showPill(text, actionLabel, onAction) {
    if (pill || isStandalone() || dismissedRecently()) return;
    pill = document.createElement('div');
    pill.setAttribute('role', 'dialog');
    pill.style.cssText = 'position:fixed;left:12px;right:12px;max-width:436px;margin:0 auto;' +
      'bottom:calc(74px + env(safe-area-inset-bottom,0px));z-index:1500;display:flex;align-items:center;gap:10px;' +
      'background:#312E81;color:#fff;padding:10px 12px 10px 14px;border-radius:18px;' +
      'box-shadow:0 8px 24px rgba(0,0,0,.28);font:600 13.5px/1.35 "Plus Jakarta Sans","Segoe UI",Arial,sans-serif;';
    var label = document.createElement('span');
    label.style.flex = '1';
    label.textContent = text;
    pill.appendChild(label);
    if (actionLabel) {
      var go = document.createElement('button');
      go.textContent = actionLabel;
      go.style.cssText = 'width:auto;padding:8px 14px;font-size:13px;border-radius:14px;background:#fff;color:#4338CA;box-shadow:none;';
      go.onclick = function () { onAction && onAction(); };
      pill.appendChild(go);
    }
    var x = document.createElement('button');
    x.textContent = '✕';
    x.setAttribute('aria-label', 'Đóng');
    x.style.cssText = 'width:auto;padding:6px 10px;font-size:14px;border-radius:12px;background:transparent;color:#C7D2FE;box-shadow:none;';
    x.onclick = function () { hidePill(true); };
    pill.appendChild(x);
    document.body.appendChild(pill);
  }
  function hidePill(remember) {
    if (pill) { pill.remove(); pill = null; }
    if (remember) { try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch (e) {} }
  }

  // Android / Chrome / Edge / PC
  var deferred = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    showPill('Cài Hill Driver lên màn hình để mở nhanh như app thật.', 'Cài app', function () {
      if (!deferred) return;
      deferred.prompt();
      deferred.userChoice.finally(function () { deferred = null; hidePill(false); });
    });
  });
  window.addEventListener('appinstalled', function () { hidePill(false); });

  // iPhone / iPad (Safari không có nút cài tự động)
  var ua = navigator.userAgent || '';
  var isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var isSafari = /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua);
  if (isIOS && isSafari) {
    window.addEventListener('load', function () {
      setTimeout(function () {
        showPill('Để cài app: bấm nút Chia sẻ ⎋ rồi chọn “Thêm vào MH chính”.', null, null);
      }, 4000);
    });
  }
})();
