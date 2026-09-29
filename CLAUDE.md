# Kingdoms

A State.io-style territory-conquest game. Vanilla JS PWA in `pwa/`, wrapped as native iOS/Android apps with Capacitor in `mobile/`. Native builds run only in GitHub Actions — do not build them locally.

## Layout

- `pwa/` — the game (no dependencies, no build step). `game.js` is a single IIFE on a canvas; `sw.js` is the offline service worker.
- `mobile/` — Capacitor 8 wrapper. `scripts/copy-www.js` copies `pwa/` into `www/` (minus `sw.js`) and injects `native-bridge.js`; `scripts/configure-native.js` patches the generated `android/` and `ios/` projects (portrait, immersive, dark splash); `scripts/make-assets.js` builds icon/splash PNGs from `pwa/icon.svg`. `android/`, `ios/`, `www/` are gitignored and regenerated in CI.
- `.github/workflows/` — `android.yml` (debug APK), `ios.yml` (unsigned simulator build), `testflight.yml` (signed build uploaded to TestFlight; needs secrets, see `mobile/README.md`).

## Conventions

- Run the PWA with a static server on `pwa/` (e.g. `python -m http.server 8080`); service workers don't work from `file://`.
- Syntax-check with `node --check pwa/game.js`.
- When any file cached by `pwa/sw.js` changes, bump `CACHE` in `sw.js` and keep `FILES` in sync.
- `game.js` skips service worker registration when `window.Capacitor.isNativePlatform()` is true — keep that.
- The native bridge depends on DOM ids `#overlay` and `#title` and on the `kingdoms:*` window events (`kingdoms:capture`, etc.). `game.js` dispatches `kingdoms:capture` in `capture()`. Win/lose haptics match the `#title` text ("complete", "Defeated") — update `mobile/native-bridge.js` if that wording changes.
- Levels are seeded, so a level is identical every time; progress is saved in `localStorage` under `kingdoms.level`.
- App id is `com.conradmicallef.kingdoms` (`mobile/capacitor.config.json`); the TestFlight workflow signs with a profile for it. The app record must exist in App Store Connect.
