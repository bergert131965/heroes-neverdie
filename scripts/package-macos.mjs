#!/usr/bin/env node
/**
 * Manual macOS packaging for HeRoes NEVERDIE.
 *
 * Produces `release/HeRoes NEVERDIE-<version>-arm64.dmg` (+ .zip + the bare
 * .app) without electron-builder, so the build only ever creates files and
 * never deletes or renames anything — required on hosts whose file
 * protections deny unlink/rename/rmdir (sandboxed safe-delete). On a
 * standard Mac `npm run dist` (electron-builder) remains available.
 *
 * The bundle keeps Electron's stock executable name (no binary rename) and
 * skips code signing; macOS runs the ad-hoc unsigned bundle locally.
 *
 * App icon: `build/icon.icns` is embedded as-is when present, otherwise a
 * 1024x1024 `build/icon.png` is expanded through sips + iconutil, otherwise
 * the staged Electron icon is kept. See build/README.md for the asset spec.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(fileURLToPath(import.meta.url));
const rootDir = join(appDir, "..");
const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
const version = pkg.version;
const productName = pkg.productName ?? "HeRoes NEVERDIE";
const releaseDir = join(rootDir, "release");
const stamp = new Date().toISOString().replaceAll(":", "").replaceAll("-", "").slice(0, 14);
const buildDir = join(releaseDir, `manual-${stamp}`);
const appBundle = join(buildDir, `${productName}.app`);

function sh(cmd, args, options = {}) {
  return execFileSync(cmd, args, { stdio: "inherit", ...options });
}

/**
 * Resolve the app icon to embed, or undefined to keep the stock Electron icon.
 *
 * `build/icon.icns` is used as-is. A `build/icon.png` is expanded into the ten
 * representations Apple expects and packed with iconutil, so a rebrand only
 * has to author one square PNG.
 */
function resolveAppIcon() {
  const icns = join(rootDir, "build", "icon.icns");
  if (existsSync(icns)) return icns;
  const png = join(rootDir, "build", "icon.png");
  if (!existsSync(png)) return undefined;

  const probe =
    spawnSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", png], { encoding: "utf8" }).stdout ?? "";
  const width = Number(/pixelWidth:\s*(\d+)/.exec(probe)?.[1]);
  const height = Number(/pixelHeight:\s*(\d+)/.exec(probe)?.[1]);
  if (Number.isFinite(width) && Number.isFinite(height)) {
    if (width !== height) {
      console.log(`[package] warning: build/icon.png is ${String(width)}x${String(height)}; macOS app icons must be square`);
    } else if (width < 1024) {
      console.log(`[package] warning: build/icon.png is ${String(width)}px; author 1024px so the large Dock and Spotlight sizes stay crisp`);
    }
  }

  const iconset = join(buildDir, "icon.iconset");
  mkdirSync(iconset, { recursive: true });
  const representations = [
    [16, "icon_16x16.png"],
    [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"],
    [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"],
    [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"],
    [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"],
    [1024, "icon_512x512@2x.png"],
  ];
  for (const [size, name] of representations) {
    sh("sips", ["-z", String(size), String(size), png, "--out", join(iconset, name)], { stdio: "ignore" });
  }
  const packed = join(buildDir, "icon.icns");
  sh("iconutil", ["-c", "icns", iconset, "-o", packed]);
  return packed;
}

// ── 1. stage the stock Electron distribution as our app bundle ─────────────
mkdirSync(buildDir, { recursive: true });
const electronDist = join(rootDir, "node_modules", "electron", "dist", "Electron.app");
if (!existsSync(electronDist)) throw new Error("electron distribution missing; run npm install first");
cpSync(electronDist, appBundle, { recursive: true });
console.log(`[package] staged ${electronDist}`);

// ── 1b. app icon (the staged Electron icon when no asset is authored) ──────
const appIcon = resolveAppIcon();
if (appIcon === undefined) {
  console.log("[package] app icon: stock Electron icon (author build/icon.png to rebrand)");
} else {
  // Keep Electron's filename so the staged Info.plist CFBundleIconFile stays valid.
  cpSync(appIcon, join(appBundle, "Contents", "Resources", "electron.icns"));
  console.log(`[package] app icon: ${relative(rootDir, appIcon)}`);
}

// ── 2. Info.plist identity (targeted XML replacements, no plist library) ───
const plistPath = join(appBundle, "Contents", "Info.plist");
let plistText = readFileSync(plistPath, "utf8");
const appId = pkg.build?.appId ?? "com.heroesneverdie.desktop";
const replaceString = (key, value) => {
  const pattern = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`);
  const next = plistText.replace(pattern, `$1${value}$2`);
  if (next === plistText) throw new Error(`package: Info.plist key ${key} not found`);
  plistText = next;
};
replaceString("CFBundleDisplayName", productName);
replaceString("CFBundleName", productName);
replaceString("CFBundleIdentifier", appId);
replaceString("CFBundleShortVersionString", version);
replaceString("CFBundleVersion", version);
if (!plistText.includes("LSApplicationCategoryType")) {
  plistText = plistText.replace(
    "</dict>\n</plist>",
    "\t<key>LSApplicationCategoryType</key>\n\t<string>public.app-category.developer-tools</string>\n</dict>\n</plist>",
  );
}
writeFileSync(plistPath, plistText);
console.log(`[package] Info.plist identity: ${appId} ${version}`);

// ── 3. application payload (Resources/app, no asar) ────────────────────────
const payloadDir = join(appBundle, "Contents", "Resources", "app");
mkdirSync(payloadDir, { recursive: true });
for (const file of ["main.js", "preload.js", "package.json"]) {
  cpSync(join(rootDir, file), join(payloadDir, file));
}
cpSync(join(rootDir, "profile"), join(payloadDir, "profile"), { recursive: true });

// Production dependency closure only (electron/electron-builder stay out).
// npm ls exits nonzero when optional platform packages are marked invalid;
// the parseable stdout still lists the real tree, so accept that status.
const listed = spawnSync("npm", ["ls", "--omit=dev", "--all", "--parseable"], {
  cwd: rootDir,
  encoding: "utf8",
}).stdout;
const rootNodeModules = join(rootDir, "node_modules");
let copied = 0;
for (const line of listed.split("\n")) {
  const source = line.trim();
  if (!source.startsWith(rootNodeModules + "/") && source !== rootNodeModules) continue;
  const rel = relative(rootNodeModules, source);
  if (rel === "") continue;
  const target = join(payloadDir, "node_modules", rel);
  if (existsSync(target)) continue;
  cpSync(source, target, { recursive: true });
  copied++;
}
console.log(`[package] copied ${String(copied)} production packages`);

// The renderer dist is resolved at runtime from @deepseek-ai/dsh-web-frontend,
// which is part of the production closure above.

// ── 4. ad-hoc signing (best effort; unsigned bundles still run locally) ─────
try {
  sh("codesign", ["--force", "--deep", "--sign", "-", appBundle]);
  console.log("[package] ad-hoc signed");
} catch (error) {
  console.log("[package] codesign skipped (runs unsigned on this machine)");
}

// ── 5. dmg + zip (fresh names: never overwrite) ────────────────────────────
const staging = join(buildDir, "dmg-stage");
mkdirSync(staging, { recursive: true });
cpSync(appBundle, join(staging, `${productName}.app`), { recursive: true });
symlinkSync("/Applications", join(staging, "Applications"));

// dmg is best-effort: hdiutil verifies its image by mounting it, which this
// host denies ("operation not permitted" under /Volumes). Standard Macs get
// the dmg either here or through `npm run dist` (electron-builder).
const dmgName = `${productName.replaceAll(" ", "-")}-${version}-arm64.dmg`;
const dmgPath = join(buildDir, dmgName);
try {
  sh("hdiutil", ["create", "-volname", productName, "-srcfolder", staging, "-format", "UDZO", dmgPath]);
  console.log(`[package] dmg: ${dmgPath}`);
} catch (error) {
  console.log("[package] dmg skipped (hdiutil mount verification denied on this host)");
}

const zipPath = join(buildDir, `${productName.replaceAll(" ", "-")}-${version}-arm64.zip`);
sh("ditto", ["-c", "-k", "--keepParent", appBundle, zipPath]);
console.log(`[package] zip: ${zipPath}`);
console.log(`[package] app: ${appBundle}`);
