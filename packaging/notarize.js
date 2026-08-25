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
// Needs APPLE_ID, APPLE_TEAM_ID, APPLE_APP_SPECIFIC_PASSWORD in the
// environment -- see packaging/README.md "Credentials". Skips entirely, with
// a warning, when they aren't set, so local/dev builds on a Mac without the
// paid cert still work (ad-hoc signed, same as before).
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

module.exports = async function afterSign(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  if (electronPlatformName !== "darwin") return;

  const { APPLE_ID, APPLE_TEAM_ID, APPLE_APP_SPECIFIC_PASSWORD } = process.env;
  if (!APPLE_ID || !APPLE_TEAM_ID || !APPLE_APP_SPECIFIC_PASSWORD) {
    console.warn(
      "[notarize] APPLE_ID / APPLE_TEAM_ID / APPLE_APP_SPECIFIC_PASSWORD not set " +
        "-- skipping notarization (ad-hoc-signed build only, see packaging/README.md).",
    );
    return;
  }

  const appPath = path.join(appOutDir, `${packager.appInfo.productFilename}.app`);

  // notarytool submit takes a zip/dmg/pkg, not a raw .app bundle.
  const zipPath = path.join(os.tmpdir(), `${packager.appInfo.productFilename}-notarize.zip`);
  console.log(`[notarize] zipping ${appPath}`);
  execFileSync("ditto", ["-c", "-k", "--keepParent", appPath, zipPath], { stdio: "inherit" });

  try {
    console.log("[notarize] submitting to Apple (this can take several minutes)");
    execFileSync(
      "xcrun",
      [
        "notarytool", "submit", zipPath,
        "--apple-id", APPLE_ID,
        "--team-id", APPLE_TEAM_ID,
        "--password", APPLE_APP_SPECIFIC_PASSWORD,
        "--wait",
      ],
      { stdio: "inherit" },
    );
  } finally {
    fs.rmSync(zipPath, { force: true });
  }

  console.log("[notarize] accepted -- stapling");
  execFileSync("xcrun", ["stapler", "staple", appPath], { stdio: "inherit" });
  console.log("[notarize] done");
};
