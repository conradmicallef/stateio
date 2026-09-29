// Idempotent patches to the generated native projects (run after `cap add` / `cap sync`):
//  Android: portrait lock, dark window/splash background, immersive fullscreen
//           (status + navigation bars hidden, swipe to reveal), no WebView overscroll.
//  iOS:     portrait lock, status bar hidden, full-screen on iPad (required for portrait lock).
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const BG = '#1B2433';
const MARK = 'kingdoms:configure-native';

function read(p) { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; }
function write(p, s, what) { fs.writeFileSync(p, s); console.log(what); }

// ------------------------------------------------------------------ Android
const androidMain = path.join(root, 'android/app/src/main');
if (fs.existsSync(androidMain)) {
  // 1. Portrait lock on MainActivity.
  const manifest = path.join(androidMain, 'AndroidManifest.xml');
  let x = read(manifest);
  if (x && !/android:screenOrientation=/.test(x)) {
    x = x.replace(/<activity\b/, '<activity\n            android:screenOrientation="portrait"');
    write(manifest, x, 'Android: portrait lock applied');
  }

  // 2. Colour resource + theme: dark window background (no white flash), dark splash.
  const values = path.join(androidMain, 'res/values');
  fs.mkdirSync(values, { recursive: true });
  write(path.join(values, 'kingdoms_colors.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<!-- ${MARK} -->\n<resources>\n    <color name="kingdoms_bg">${BG}</color>\n</resources>\n`,
    'Android: kingdoms_bg colour written');

  const stylesPath = path.join(values, 'styles.xml');
  let styles = read(stylesPath);
  if (styles) {
    const addItems = (styleName, items) => {
      const re = new RegExp(`(<style\\s+name="${styleName.replace(/\./g, '\\.')}"[^>]*>)([\\s\\S]*?)(</style>)`);
      styles = styles.replace(re, (m, open, body, close) => {
        let add = '';
        for (const [k, v] of items) {
          if (!body.includes(`name="${k}"`)) add += `\n        <item name="${k}">${v}</item>`;
        }
        return open + body.replace(/\s*$/, '') + add + '\n    ' + close;
      });
    };
    addItems('AppTheme.NoActionBar', [
      ['android:windowBackground', '@color/kingdoms_bg'],
      ['android:statusBarColor', '@android:color/transparent'],
      ['android:navigationBarColor', '@color/kingdoms_bg'],
    ]);
    addItems('AppTheme.NoActionBarLaunch', [
      ['windowSplashScreenBackground', '@color/kingdoms_bg'],
      ['android:windowBackground', '@color/kingdoms_bg'],
    ]);
    write(stylesPath, styles, 'Android: dark theme/splash background applied');
  }

  // 3. MainActivity: immersive fullscreen + no overscroll glow.
  const javaRoot = path.join(androidMain, 'java');
  const findMain = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { const r = findMain(p); if (r) return r; }
      else if (e.name === 'MainActivity.java') return p;
    }
    return null;
  };
  const mainActivity = fs.existsSync(javaRoot) ? findMain(javaRoot) : null;
  const src = mainActivity && read(mainActivity);
  if (src && !src.includes(MARK)) {
    const pkg = (src.match(/^\s*package\s+([\w.]+)\s*;/m) || [])[1];
    const pristine = /public\s+class\s+MainActivity\s+extends\s+BridgeActivity\s*\{\s*\}/.test(src);
    if (pkg && pristine) {
      write(mainActivity, `package ${pkg};

import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

// ${MARK}: immersive fullscreen game activity (generated, safe to edit).
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (getBridge() != null) {
            WebView wv = getBridge().getWebView();
            if (wv != null) {
                wv.setOverScrollMode(View.OVER_SCROLL_NEVER);
                wv.setVerticalScrollBarEnabled(false);
                wv.setHorizontalScrollBarEnabled(false);
                wv.setHapticFeedbackEnabled(false);
            }
        }
        hideSystemBars();
    }

    @Override
    public void onResume() {
        super.onResume();
        hideSystemBars();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    private void hideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat c =
            WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        c.hide(WindowInsetsCompat.Type.systemBars());
    }
}
`, 'Android: immersive MainActivity written');
    } else {
      console.warn('Android: MainActivity.java is customised; immersive patch skipped (add it manually).');
    }
  }
}

// ---------------------------------------------------------------------- iOS
const plist = path.join(root, 'ios/App/App/Info.plist');
let p = read(plist);
if (p) {
  // Portrait only (iPhone + iPad).
  const portrait = '<array>\n\t\t<string>UIInterfaceOrientationPortrait</string>\n\t</array>';
  for (const key of ['UISupportedInterfaceOrientations', 'UISupportedInterfaceOrientations~ipad']) {
    const re = new RegExp('(<key>' + key.replace(/~/g, '\\~') + '</key>\\s*)<array>[\\s\\S]*?</array>');
    if (re.test(p)) p = p.replace(re, '$1' + portrait);
  }
  // Booleans: hidden status bar (at launch and in-app), iPad full screen.
  const setBool = (key, val) => {
    const re = new RegExp('(<key>' + key + '</key>\\s*)<(true|false)\\s*/>');
    if (re.test(p)) p = p.replace(re, `$1<${val}/>`);
    else {
      const i = p.lastIndexOf('</dict>');
      p = p.slice(0, i) + `\t<key>${key}</key>\n\t<${val}/>\n` + p.slice(i);
    }
  };
  setBool('UIStatusBarHidden', true);
  setBool('UIViewControllerBasedStatusBarAppearance', false);
  setBool('UIRequiresFullScreen', true);
  // Export compliance: only exempt (HTTPS/OS) encryption, so TestFlight skips the compliance prompt.
  setBool('ITSAppUsesNonExemptEncryption', false);
  write(plist, p, 'iOS: portrait lock, hidden status bar, iPad full screen, export compliance applied');
}
