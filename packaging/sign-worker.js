// electron-builder afterPack hook.
//
// electron-builder's own mac signing step covers the outer .app bundle but
// not `extraResources` content, so the PyInstaller worker copied into
// Contents/Resources/worker/ -- several hundred .so/.dylib Mach-O files from
// mediapipe, onnxruntime, rawpy/libraw, opencv, numpy, plus PyInstaller's own
// frozen Python.framework -- would otherwise ship completely unsigned. Every
// Mach-O in there needs its own signature before the outer bundle is sealed,
// signed **inside-out** (deepest paths first): an outer signature seals what's
// beneath it, so signing something afterwards invalidates that seal. Framework
// bundles (Python.framework) are the exception to "flat Mach-O file": they
// sign as a bundle at their top-level .framework path, not as the bare
// Mach-O inside -- see findFrameworkDirs below.
//
// This hook always signs the worker. When a Developer ID Application
// identity is installed in the keychain, it uses that (with hardened-runtime
// entitlements, ready for notarization -- see packaging/notarize.js). When
// none is installed -- a dev machine without the paid cert -- it falls back
// to ad-hoc signing, and additionally ad-hoc-signs the *outer* .app itself
// (afterPack runs after all content is placed but before electron-builder's
// own signing step, so this is safe): without a real identity,
// electron-builder's own signing step finds nothing to sign and skips
// silently, and an unsigned bundle shows macOS's unfixable "app is damaged"
// dialog rather than the normal bypassable one. This is exactly what
// packaging/afterSign.js used to do for the whole bundle; that file is
// retired now that this hook covers both cases.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const MACHO_MAGICS = [
  Buffer.from([0xfe, 0xed, 0xfa, 0xce]), // 32-bit
  Buffer.from([0xce, 0xfa, 0xed, 0xfe]), // 32-bit, byte-swapped
  Buffer.from([0xfe, 0xed, 0xfa, 0xcf]), // 64-bit
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), // 64-bit, byte-swapped
  Buffer.from([0xca, 0xfe, 0xba, 0xbe]), // fat/universal
  Buffer.from([0xbe, 0xba, 0xfe, 0xca]), // fat/universal, byte-swapped
];

function isMachO(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(4);
    const bytesRead = fs.readSync(fd, buf, 0, 4, 0);
    if (bytesRead < 4) return false;
    return MACHO_MAGICS.some((magic) => buf.equals(magic));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function findMachOFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (entry.name.endsWith(".framework")) continue; // signed as a bundle, see findFrameworkDirs
      findMachOFiles(full, out);
    } else if (entry.isFile() && isMachO(full)) {
      out.push(full);
    }
  }
  return out;
}

// PyInstaller freezes Python itself as a versioned framework bundle
// (Python.framework/Versions/3.12/{Python,Resources/Info.plist}, with
// Python/Resources/Versions-Current as symlinks). Signing the inner `Python`
// Mach-O as a bare file -- which findMachOFiles would otherwise do, since it
// IS a Mach-O -- produces a signature that doesn't seal Info.plist or
// Resources, which both `codesign --verify --deep --strict` and Apple's
// notary service reject. A versioned framework has to be signed as a bundle,
// at its version directory (codesign resolves Versions/Current itself).
function findFrameworkDirs(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.name.endsWith(".framework")) {
      out.push(full);
      continue; // frameworks don't nest
    }
    findFrameworkDirs(full, out);
  }
  return out;
}

function findDeveloperIdIdentity() {
  let output;
  try {
    output = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], {
      encoding: "utf8",
    });
  } catch {
    return null;
  }
  const match = output.match(/"(Developer ID Application:[^"]+)"/);
  return match ? match[1] : null;
}

module.exports = async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  if (electronPlatformName !== "darwin") return;

  const appPath = path.join(appOutDir, `${packager.appInfo.productFilename}.app`);
  const workerDir = path.join(appPath, "Contents", "Resources", "worker");
  const entitlementsMain = path.join(__dirname, "entitlements.mac.plist");
  const entitlementsInherit = path.join(__dirname, "entitlements.mac.inherit.plist");

  const identity = findDeveloperIdIdentity();
  const isAdHoc = !identity;
  if (isAdHoc) {
    console.warn(
      "[sign-worker] no Developer ID Application identity in keychain -- ad-hoc " +
        "signing the worker and the outer app (fine for local/dev builds, not for " +
        "public releases).",
    );
  } else {
    console.log(`[sign-worker] signing worker with ${identity}`);
  }

  const sign = (target, entitlements) => {
    const args = ["--force", "--timestamp"];
    if (!isAdHoc) {
      args.push("--options", "runtime");
      if (entitlements) args.push("--entitlements", entitlements);
    }
    args.push("--sign", isAdHoc ? "-" : identity, target);
    execFileSync("codesign", args, { stdio: "inherit" });
  };

  const verify = (target) => {
    execFileSync("codesign", ["--verify", "--strict", "--verbose=2", target], {
      stdio: "inherit",
    });
  };

  if (fs.existsSync(workerDir)) {
    const workerBin = path.join(workerDir, "photocull-worker");

    // Framework bundles (PyInstaller freezes Python itself as one) sign as a
    // bundle at their top-level .framework path -- codesign resolves the
    // Versions/Current symlink and seals Info.plist + Resources correctly
    // that way, same as electron-builder does for Electron Framework.framework.
    // No entitlements: they're meaningless on a library and can confuse the
    // notary service.
    const frameworks = findFrameworkDirs(workerDir);
    for (const fw of frameworks) sign(fw, null);

    const machOFiles = findMachOFiles(workerDir)
      .filter((p) => p !== workerBin)
      // Deepest paths first, so nested libs are sealed before anything that
      // references them.
      .sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);

    for (const bin of machOFiles) sign(bin, entitlementsInherit);

    // The worker executable itself is the process that actually needs
    // JIT/DYLD_* -- sign it last, with the main entitlements.
    if (fs.existsSync(workerBin)) sign(workerBin, entitlementsMain);

    // Fail the build here, not 10 minutes later in a notary rejection log --
    // a miss in the walk above is a build-time bug, not a notarization-time
    // surprise.
    for (const fw of frameworks) verify(fw);
    if (fs.existsSync(workerBin)) verify(workerBin);

    console.log(
      `[sign-worker] signed ${machOFiles.length + 1} binaries and ` +
        `${frameworks.length} framework(s) in ${workerDir}`,
    );
  } else {
    console.warn(`[sign-worker] no worker dir at ${workerDir}, skipping`);
  }

  if (isAdHoc) {
    // No real identity -> electron-builder's own signing step will find
    // nothing and skip. Ad-hoc sign the whole bundle ourselves so it's at
    // least sealed (avoids the unfixable "app is damaged" dialog).
    execFileSync(
      "codesign",
      ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath],
      { stdio: "inherit" },
    );
    execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
      stdio: "inherit",
    });
    console.log("[sign-worker] ad-hoc signed and verified the outer app");
  }
};
