# Kingdoms - Capacitor wrapper

Wraps `../pwa` as native iOS/Android apps (Capacitor 8, Java 21, Node 22).
App id `com.conradmicallef.kingdoms`, name `Kingdoms` (see `capacitor.config.json`).

## How it works
- `npm run prepare-www` copies `../pwa` into `www/` (skips `sw.js`; game.js also skips SW registration when native),
  copies `native-bridge.js` into `www/` and injects `<script src="native-bridge.js">` before `game.js`.
  The PWA itself is never modified; the bridge only runs when `Capacitor.isNativePlatform()`.
- `npx cap add android|ios` generates the native projects (done in CI if absent).
- `npm run assets:android|ios` rasterises `../pwa/icon.svg` into `assets/*.png` (`scripts/make-assets.js`, via `sharp`),
  then `@capacitor/assets` generates all launcher icons (incl. Android adaptive) and splash images. No PNG is committed.
- `scripts/configure-native.js` (idempotent, run after every sync) patches the native projects.

## Native feel (State.io-style)
| Feature | How |
|---|---|
| Fullscreen / immersive | Android: generated `MainActivity` hides status + nav bars (swipe to reveal transiently), re-applied on resume/focus. iOS: `UIStatusBarHidden` + `UIViewControllerBasedStatusBarAppearance=false`. |
| Portrait lock | AndroidManifest `screenOrientation=portrait`; Info.plist portrait-only (iPhone + iPad) + `UIRequiresFullScreen` (needed for iPad). |
| Safe areas / notch | iOS: `contentInset: never` + `viewport-fit=cover`; the HUD uses `env(safe-area-inset-top)`. Android: default cutout mode letterboxes the notch while bars are hidden, so nothing is drawn under it. |
| No overscroll / bounce | iOS `scrollEnabled: false`; Android WebView `OVER_SCROLL_NEVER`; CSS `overscroll-behavior:none`; long-press menu/callout disabled. |
| Dark splash / no white flash | `#1b2433` everywhere: Capacitor `backgroundColor`, SplashScreen plugin, Android window + Android 12 splash background, generated splash images. |
| Haptics | `@capacitor/haptics`: medium impact on capture, heavy when you lose a tower, success/error notification on win/lose. |
| Keep awake | `@capacitor-community/keep-awake`: on while playing (overlay hidden), released on menus and when backgrounded. |
| Android back | In menus: minimise app. In a level: "Press back again to exit" toast, second press within 2 s minimises. |

Win/lose haptics and keep-awake work by watching the DOM (`#overlay.show`, `#title` text). Capture haptics are wired:
`game.js` dispatches `kingdoms:capture` from `capture()`.
Other optional hooks: `kingdoms:send`, `kingdoms:win`, `kingdoms:lose`, `kingdoms:haptic` (`detail.type`).
The bridge fires `kingdoms:back` (cancelable, `preventDefault()` to handle back yourself, e.g. to pause) and
`kingdoms:appstate` (`detail.active`). `window.KingdomsNative.haptic(kind)` is also available in native builds.

## CI (repo root = `state/`)
Both workflows run on changes to `pwa/`, `mobile/` or the workflow file, and on manual dispatch.
- `.github/workflows/android.yml` (ubuntu, Java 21): artifact `kingdoms-debug-apk`.
- `.github/workflows/ios.yml` (macos-26 / Xcode 26): unsigned simulator build, artifact `kingdoms-ios-simulator-app`
  (unzip, then `xcrun simctl install booted App.app`).
- Pipeline: npm install -> prepare-www -> cap add (if absent) -> assets -> cap sync -> configure-native -> build.
- Caching: `~/.npm` (works without a lockfile) and Gradle via `gradle/actions/setup-gradle`.

## TestFlight (`.github/workflows/testflight.yml`)
Manual dispatch or a `v*` tag builds a signed Release archive and uploads it with `altool`. Add these repository secrets:
| Secret | Value |
|---|---|
| `BUILD_CERTIFICATE_BASE64` | Apple Distribution certificate exported as `.p12`, base64-encoded |
| `P12_PASSWORD` | password of that `.p12` |
| `PROVISIONING_PROFILE_BASE64` | App Store provisioning profile for the app id, base64-encoded |
| `APPLE_TEAM_ID` | 10-character team id |
| `ASC_KEY_ID`, `ASC_ISSUER_ID` | App Store Connect API key id and issuer id |
| `ASC_KEY_BASE64` | the API key `.p8`, base64-encoded |
Also: create the app record in App Store Connect with that bundle id. The build number is the run number.

## Local steps (optional)
```
cd mobile
npm install
npm run prepare-www
npx cap add android   # and/or: npx cap add ios (macOS)
npm run assets:android   # / assets:ios
npm run sync
```

## Manual steps
- Run `npm install` once and commit `package-lock.json` for reproducible `npm ci`.
- Android release: create a keystore, add signing config and GitHub secrets, use `bundleRelease`.
- iOS device/App Store: needs an Apple Developer account, certificate and provisioning profile; `ios.yml` is an unsigned simulator build; `testflight.yml` does the signed upload.
- `android/` and `ios/` are gitignored (regenerated in CI). If you commit them, keep running `npm run configure-native`
  after syncs; a customised `MainActivity.java` is left alone (the immersive patch is then skipped with a warning).
- Custom icon art: edit `pwa/icon.svg` (or change `scripts/make-assets.js`); `assets/` is regenerated each run.
