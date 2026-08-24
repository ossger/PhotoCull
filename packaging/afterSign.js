// electron-builder afterSign hook.
//
// electron-builder's own mac signing step only fires when it finds a Developer ID
// identity in the keychain; with none installed (see mac.identity: "-" in
// apps/shell/package.json — no paid Apple Developer ID for this project) it just
// skips signing and leaves the .app with nothing but the raw ad-hoc/linker signature
// Electron's own build already carried on its main executable. That signature does
// not cover the bundle we assembled (our extraResources worker, app.asar, Info.plist)
// — `Sealed Resources=none` — and macOS Gatekeeper's behavior for a *fully* unsigned,
// quarantined app on Apple Silicon is the unfixable "App is damaged and can't be
// opened" dialog, not the normal (bypassable) "unidentified developer" prompt.
//
// So we do the ad-hoc signing ourselves here, over everything electron-builder
// assembled: the PyInstaller worker's few hundred native libs, Electron's helper
// apps/frameworks, and the outer .app. `--deep` is deprecated by Apple for
// notarization workflows (it can attach wrong entitlements to nested code) — but
// this is plain ad-hoc signing with no entitlements and no notarization, which is
// exactly the case Apple's own codesign(1) still documents `--deep` as fine for.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

module.exports = async function afterSign(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  if (electronPlatformName !== "darwin") return;

  const appPath = path.join(appOutDir, `${packager.appInfo.productFilename}.app`);
  console.log(`[afterSign] ad-hoc signing ${appPath}`);

  execFileSync(
    "codesign",
    ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath],
    { stdio: "inherit" }
  );

  // --strict catches structural issues (missing seals, bad Info.plist refs);
  // --deep re-verifies every nested signature, not just the outer bundle.
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
    stdio: "inherit",
  });
  console.log("[afterSign] signature verified");
};
