// pnpm release: the installer for a GitHub release, signed for the in-app
// updater, plus the latest.json the updater reads.
//
// Needs Track's private key, made with `pnpm tauri signer generate`, and its
// password: TRACK_SIGNING_KEY (a path or the key itself; defaults to
// %USERPROFILE%\.tauri\track.key) and TRACK_SIGNING_KEY_PASSWORD, from this
// shell or from your Windows user environment variables. Tauri's generic
// TAURI_SIGNING_PRIVATE_KEY(_PASSWORD) work as a fallback.
//
// Writes target/release/bundle/nsis/latest.json; attach it to the release
// next to the installer. Optional: `pnpm release --notes notes.md` puts a
// file's text in latest.json as the update's notes.
// `pnpm release:unsigned` builds the same installer without the key.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "ManyGlue0/Track";

/** A variable from this shell, else from the user's Windows environment. */
function userEnv(name) {
  if (process.env[name]) return process.env[name];
  try {
    const out = execFileSync("reg", ["query", "HKCU\\Environment", "/v", name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    // "    NAME    REG_SZ    value": keep the value exactly, spaces and all.
    const m = out.match(new RegExp(`^\\s+${name}\\s+(REG_SZ|REG_EXPAND_SZ)    (.*?)\\r?$`, "m"));
    if (!m) return undefined;
    return m[1] === "REG_EXPAND_SZ" ? m[2].replace(/%([^%]+)%/g, (_, v) => process.env[v] ?? "") : m[2];
  } catch {
    return undefined;
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

// The three version numbers must agree: the updater compares tauri.conf.json's.
const conf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const { version } = conf;
const cargo = readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8").match(/^version = "(.+)"$/m)?.[1];
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
if (cargo !== version || pkg !== version) {
  fail(`Versions differ: tauri.conf.json ${version}, Cargo.toml ${cargo}, package.json ${pkg}.`);
}
if (!conf.plugins?.updater?.pubkey) {
  fail("plugins.updater.pubkey in src-tauri/tauri.conf.json is empty: paste the line from track.key.pub there.");
}

const key = userEnv("TRACK_SIGNING_KEY") ?? userEnv("TAURI_SIGNING_PRIVATE_KEY") ?? join(homedir(), ".tauri", "track.key");
const password = userEnv("TRACK_SIGNING_KEY_PASSWORD") ?? userEnv("TAURI_SIGNING_PRIVATE_KEY_PASSWORD");
if (!existsSync(key) && !key.includes("untrusted comment")) {
  fail(`No private key at ${key}. Make one with: pnpm tauri signer generate -w "${key}"`);
}
if (password === undefined) {
  fail("Set TRACK_SIGNING_KEY_PASSWORD (in this shell or as a Windows user variable).");
}

const build = spawnSync(
  "pnpm",
  ["tauri", "build", "--config", "src-tauri/tauri.release.json", "--config", "src-tauri/tauri.updater.json"],
  {
    cwd: root,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: key, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password },
  },
);
if (build.status !== 0) process.exit(build.status ?? 1);

const dir = join(root, "target", "release", "bundle", "nsis");
const installer = `Track_${version}_x64-setup.exe`;
const sig = join(dir, `${installer}.sig`);
if (!existsSync(sig)) fail(`The build didn't sign the installer (${sig} is missing).`);

const notesAt = process.argv.indexOf("--notes");
const latest = {
  version,
  notes: notesAt > 0 ? readFileSync(process.argv[notesAt + 1], "utf8").trim() : "",
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature: readFileSync(sig, "utf8").trim(),
      url: `https://github.com/${REPO}/releases/download/v${version}/${installer}`,
    },
  },
};
writeFileSync(join(dir, "latest.json"), JSON.stringify(latest, null, 2) + "\n");
console.log(`\nSigned ${installer}\nWrote ${join(dir, "latest.json")}\nAttach both to the v${version} release.`);
