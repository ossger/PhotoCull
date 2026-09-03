// Shared credential handling for the two notarization hooks
// (packaging/notarize.js and packaging/notarize-dmg.js).
//
// **Why this file exists.** Passing the app-specific password as a
// `--password` argv element leaks it twice over:
//   - it is visible in a process listing for as long as the submission runs
//     (a `ps aux` mid-build printed it in full, 2026-08-28);
//   - when `notarytool` exits non-zero, Node's execFileSync error message
//     *is* the full command line, so the password lands in the build log and
//     in whatever transcript captured it (2026-09-03, an expired credential).
// Both have now happened. A notarytool **keychain profile** avoids both: the
// password is stored once, interactively, and afterwards referenced by name.
//
// Create the profile once on the build Mac (it prompts for the password, so
// the secret never touches an argv or a shell history):
//
//   xcrun notarytool store-credentials photocull-notary \
//       --apple-id "<apple-id>" --team-id "<team-id>"
//
// Then build exactly as before -- no exported credentials needed.
//
// Resolution order:
//   1. `APPLE_NOTARY_KEYCHAIN_PROFILE`, if set, is used verbatim.
//   2. The default `photocull-notary` profile, if it exists in the keychain.
//   3. The APPLE_ID / APPLE_TEAM_ID / APPLE_APP_SPECIFIC_PASSWORD env vars
//      (kept for CI, where no keychain exists). The argv is scrubbed on
//      failure, but prefer a profile on a real machine.
//   4. Nothing -- the caller skips notarization with a warning, so a build on
//      a Mac without the paid cert still succeeds (ad-hoc signed).
const { execFileSync } = require("node:child_process");

const DEFAULT_PROFILE = "photocull-notary";

// notarytool stores its profiles as generic keychain items under this service.
// Probing without `-w` checks existence without reading (or prompting for)
// the secret itself.
function keychainProfileExists(name) {
  try {
    execFileSync("security", ["find-generic-password", "-s", "com.apple.gke.notary.tool", "-a", name], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

// Returns the notarytool authentication arguments, or null when no
// credentials are configured at all.
function notaryAuthArgs() {
  const explicitProfile = process.env.APPLE_NOTARY_KEYCHAIN_PROFILE;
  if (explicitProfile) return ["--keychain-profile", explicitProfile];

  if (keychainProfileExists(DEFAULT_PROFILE)) return ["--keychain-profile", DEFAULT_PROFILE];

  const { APPLE_ID, APPLE_TEAM_ID, APPLE_APP_SPECIFIC_PASSWORD } = process.env;
  if (APPLE_ID && APPLE_TEAM_ID && APPLE_APP_SPECIFIC_PASSWORD) {
    return [
      "--apple-id", APPLE_ID,
      "--team-id", APPLE_TEAM_ID,
      "--password", APPLE_APP_SPECIFIC_PASSWORD,
    ];
  }

  return null;
}

// The message a caller prints when notaryAuthArgs() comes back null.
const NO_CREDENTIALS_HINT =
  "no notarization credentials -- skipping (build is signed but not notarized). " +
  "Create a keychain profile with: xcrun notarytool store-credentials " +
  `${DEFAULT_PROFILE} --apple-id "<apple-id>" --team-id "<team-id>" ` +
  "(see packaging/README.md).";

// Run `xcrun notarytool <args>` with the failure path scrubbed: on a non-zero
// exit, Node's own error carries the whole command line, so it is replaced
// with one that names the subcommand only. Never let the raw error escape --
// under the env-var fallback it contains the password.
function runNotary(args) {
  try {
    execFileSync("xcrun", ["notarytool", ...args], { stdio: "inherit" });
  } catch (err) {
    const subcommand = args[0] || "notarytool";
    throw new Error(
      `xcrun notarytool ${subcommand} failed (exit ${err.status ?? "?"}). ` +
        "The tool's own output is above; the command line is withheld because " +
        "it may carry an app-specific password.",
    );
  }
}

module.exports = { notaryAuthArgs, runNotary, NO_CREDENTIALS_HINT, DEFAULT_PROFILE };
