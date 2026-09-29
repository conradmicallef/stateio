/*
 * Kingdoms native bridge (Capacitor only).
 *
 * scripts/copy-www.js copies this file into www/ and injects
 *   <script src="native-bridge.js"></script>
 * before game.js. It is never part of the PWA, and it no-ops unless
 * window.Capacitor.isNativePlatform() is true.
 *
 * Plugins are looked up at runtime through the Capacitor global (no bundler),
 * and every call is guarded, so a missing plugin never breaks the game.
 *
 * Optional hooks game.js can fire (they are harmless on the web):
 *   window.dispatchEvent(new CustomEvent('kingdoms:capture', { detail: { lost: false } }))
 *   window.dispatchEvent(new CustomEvent('kingdoms:send'))
 *   window.dispatchEvent(new CustomEvent('kingdoms:win'))
 *   window.dispatchEvent(new CustomEvent('kingdoms:lose'))
 *   window.dispatchEvent(new CustomEvent('kingdoms:haptic', { detail: { type: 'capture' } }))
 * Events the bridge fires for game.js:
 *   'kingdoms:back' (cancelable: call preventDefault() to handle Android back yourself)
 *   'kingdoms:appstate' (detail: { active: boolean })
 * Win/lose haptics also work without hooks (it watches the #title text).
 */
(function () {
  'use strict';
  var C = window.Capacitor;
  if (!C || typeof C.isNativePlatform !== 'function' || !C.isNativePlatform()) return;

  var platform = typeof C.getPlatform === 'function' ? C.getPlatform() : 'native';

  // ---------- plugin access ----------
  var cache = {};
  function plugin(name) {
    if (Object.prototype.hasOwnProperty.call(cache, name)) return cache[name];
    var p = null;
    try {
      var available = typeof C.isPluginAvailable === 'function' ? C.isPluginAvailable(name) : true;
      if (available) {
        p = (C.Plugins && C.Plugins[name]) ||
            (typeof C.registerPlugin === 'function' ? C.registerPlugin(name) : null);
      }
    } catch (e) { p = null; }
    cache[name] = p;
    return p;
  }
  function call(name, method, arg) {
    var p = plugin(name);
    if (!p) return Promise.resolve();
    try {
      return Promise.resolve(p[method](arg)).catch(function () {});
    } catch (e) {
      return Promise.resolve();
    }
  }
  function emit(type, detail, cancelable) {
    try {
      return window.dispatchEvent(new CustomEvent(type, { detail: detail, cancelable: !!cancelable }));
    } catch (e) { return true; }
  }

  // ---------- native-only CSS ----------
  document.documentElement.classList.add('native', 'native-' + platform);
  var style = document.createElement('style');
  style.textContent =
    'html,body{overscroll-behavior:none;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}' +
    '.kn-toast{position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom) + 48px);transform:translateX(-50%);' +
    'background:#000c;color:#fff;padding:10px 18px;border-radius:20px;font:600 15px system-ui,sans-serif;' +
    'z-index:9999;pointer-events:none;opacity:0;transition:opacity .2s}' +
    '.kn-toast.on{opacity:1}';
  (document.head || document.documentElement).appendChild(style);
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  var toastEl = null, toastTimer = 0;
  function toast(text) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'kn-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('on'); }, 1800);
  }

  // ---------- haptics ----------
  var HAPTICS = {
    tap:     ['impact', { style: 'LIGHT' }],
    send:    ['impact', { style: 'LIGHT' }],
    capture: ['impact', { style: 'MEDIUM' }],
    lost:    ['impact', { style: 'HEAVY' }],
    win:     ['notification', { type: 'SUCCESS' }],
    lose:    ['notification', { type: 'ERROR' }]
  };
  var lastHaptic = 0, lastOutcome = 0;
  function haptic(kind) {
    var h = HAPTICS[kind] || HAPTICS.tap;
    var now = Date.now();
    if (kind === 'win' || kind === 'lose') {
      if (now - lastOutcome < 2000) return;   // de-dupe hook + fallback detection
      lastOutcome = now;
    } else if (now - lastHaptic < 45) {
      return;                                  // throttle bursts of captures
    }
    lastHaptic = now;
    call('Haptics', h[0], h[1]);
  }
  window.addEventListener('kingdoms:capture', function (e) {
    haptic(e.detail && e.detail.lost ? 'lost' : 'capture');
  });
  window.addEventListener('kingdoms:send', function () { haptic('send'); });
  window.addEventListener('kingdoms:win', function () { haptic('win'); });
  window.addEventListener('kingdoms:lose', function () { haptic('lose'); });
  window.addEventListener('kingdoms:haptic', function (e) { haptic(e.detail && e.detail.type); });

  // ---------- game state (DOM based, no game.js changes needed) ----------
  var overlay = document.getElementById('overlay');
  function inMenu() { return !!overlay && overlay.classList.contains('show'); }

  // Fallback win/lose detection: game.js rewrites #title when a level ends.
  var title = document.getElementById('title');
  if (title && window.MutationObserver) {
    new MutationObserver(function () {
      var t = (title.textContent || '').toLowerCase();
      if (/victor|complete|you win|you won|conquer/.test(t)) haptic('win');
      else if (/defeat|you lose|you lost|fallen|game over/.test(t)) haptic('lose');
    }).observe(title, { childList: true, characterData: true, subtree: true });
  }

  // ---------- keep awake while playing ----------
  var appActive = true, awake = null;
  function updateAwake() {
    var want = appActive && !inMenu();
    if (want === awake) return;
    awake = want;
    call('KeepAwake', want ? 'keepAwake' : 'allowSleep');
  }
  if (overlay && window.MutationObserver) {
    new MutationObserver(updateAwake).observe(overlay, { attributes: true, attributeFilter: ['class'] });
  }

  // ---------- app lifecycle + Android back button ----------
  var backArmed = 0;
  function leave() {
    var App = plugin('App');
    if (!App) return;
    Promise.resolve()
      .then(function () { return App.minimizeApp(); })
      .catch(function () { return App.exitApp(); })
      .catch(function () {});
  }
  function onBack() {
    if (!emit('kingdoms:back', null, true)) return;    // game handled it
    if (inMenu()) return leave();
    var now = Date.now();
    if (now - backArmed < 2000) return leave();
    backArmed = now;
    toast('Press back again to exit');
  }
  var App = plugin('App');
  if (App) {
    try {
      Promise.resolve(App.addListener('appStateChange', function (s) {
        appActive = !!(s && s.isActive);
        awake = null;                                   // re-apply after resume
        updateAwake();
        emit('kingdoms:appstate', { active: appActive });
      })).catch(function () {});
      if (platform === 'android') {
        Promise.resolve(App.addListener('backButton', onBack)).catch(function () {});
      }
    } catch (e) { /* plugin missing or old */ }
  }

  function ready() {
    updateAwake();
    call('SplashScreen', 'hide', { fadeOutDuration: 250 });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();

  window.KingdomsNative = { platform: platform, haptic: haptic, toast: toast };
})();
