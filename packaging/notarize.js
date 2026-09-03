// electron-builder afterSign hook.
//
// electron-builder's built-in `mac.notarize` config shape is version-
// sensitive (it moved to `mac.sign.notarize` in v27; this repo is pinned to
// 24.13.3, where the docs are ambiguous about whether a bare `true` is
// honoured). Rather than guess, `mac.notarize` is explicitly set to `false`
// in apps/shell/package.json and this hook owns notarization directly via
// `xcrun notarytool`, which is stable across electron-builder versions.
//
// afterSign fires after electron-builder's own signing step, so by the time
// this runs the outer .app is already signed with the Developer ID identity
// (hardened runtime + entitlements from apps/shell/package.json's `mac`
// block) -- see packaging/sign-worker.js for the worker sidecar's signing,
// which happens earlier (afterPack).
//
// Credentials come from packaging/notary-auth.js -- a notarytool keychain
// profile by preference, the APPLE_* env vars as a fallback. Skips entirely,
// with a warning, when neither is configured, so local/dev builds on a Mac
// without the paid cert still work (ad-hoc signed, same as before).
const { execFileSync } = require("node:child_process");
const { notaryAuthArgs, runNotary, NO_CREDENTIALS_HINT } = require("./notary-auth");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

module.exports = async function afterSign(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  if (electronPlatformName !== "darwin") return;

  const authArgs = notaryAuthArgs();
  if (!authArgs) {
    console.warn(`[notarize] ${NO_CREDENTIALS_HINT}`);
    return;
  }

  const appPath = path.join(appOutDir, `${packager.appInfo.productFilename}.app`);

  // notarytool submit takes a zip/dmg/pkg, not a raw .app bundle.
  const zipPath = path.join(os.tmpdir(), `${packager.appInfo.productFilename}-notarize.zip`);
  console.log(`[notarize] zipping ${appPath}`);
  execFileSync("ditto", ["-c", "-k", "--keepParent", appPath, zipPath], { stdio: "inherit" });

  try {
    console.log("[notarize] submitting to Apple (this can take several minutes)");
    runNotary(["submit", zipPath, ...authArgs, "--wait"]);
  } finally {
    fs.rmSync(zipPath, { force: true });
  }

  console.log("[notarize] accepted -- stapling");
  execFileSync("xcrun", ["stapler", "staple", appPath], { stdio: "inherit" });
  console.log("[notarize] done");
};
