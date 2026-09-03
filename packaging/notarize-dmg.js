// electron-builder afterAllArtifactBuild hook.
//
// packaging/notarize.js (afterSign) notarizes and staples the .app -- which
// is what ends up installed and running -- but electron-builder builds the
// .dmg from that already-signed .app *after* afterSign runs, so the dmg
// itself is signed (electron-builder signs the disk image with the same
// identity) but never submitted to Apple. The dmg is what actually gets
// downloaded and double-clicked, and Gatekeeper can still block opening an
// unnotarized disk image even though the app inside is notarized -- Apple's
// own guidance is to notarize the artifact you actually distribute. This
// hook does that: after all artifacts are built, submit each .dmg and staple
// the ticket to it directly (dmg tickets staple to the image itself, no
// re-mount needed).
//
// Same credential contract as notarize.js (packaging/notary-auth.js: a
// notarytool keychain profile by preference, the APPLE_* env vars as a
// fallback) and the same skip-with-a-warning behavior when neither is
// configured, so a cert-less dev build is untouched.
const { execFileSync } = require("node:child_process");
const { notaryAuthArgs, runNotary, NO_CREDENTIALS_HINT } = require("./notary-auth");

module.exports = async function afterAllArtifactBuild(buildResult) {
  const dmgPaths = (buildResult.artifactPaths || []).filter((p) => p.endsWith(".dmg"));
  if (dmgPaths.length === 0) return;

  const authArgs = notaryAuthArgs();
  if (!authArgs) {
    console.warn(`[notarize-dmg] ${NO_CREDENTIALS_HINT}`);
    return;
  }

  for (const dmgPath of dmgPaths) {
    console.log(`[notarize-dmg] submitting ${dmgPath} to Apple (this can take several minutes)`);
    runNotary(["submit", dmgPath, ...authArgs, "--wait"]);

    console.log(`[notarize-dmg] accepted -- stapling ${dmgPath}`);
    execFileSync("xcrun", ["stapler", "staple", dmgPath], { stdio: "inherit" });
  }

  console.log(`[notarize-dmg] done (${dmgPaths.length} dmg(s))`);
};
