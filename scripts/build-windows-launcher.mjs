#!/usr/bin/env node
// Builds and checks the native Windows launcher in assets/windows-launcher/,
// installed as the managed shim's git.exe and as the installer's clio-coder.exe.
//
//   node scripts/build-windows-launcher.mjs --verify-pins   committed binaries match pins.json (no compiler)
//   node scripts/build-windows-launcher.mjs --check         rebuild with the pinned zig and compare byte for byte
//   node scripts/build-windows-launcher.mjs --write         rebuild into assets/windows-launcher/ and update pins.json
//
// --zig <path> uses that zig binary (it must report ZIG_VERSION). Otherwise the
// pinned zig release is downloaded, checked against its SHA-256 and unpacked
// under $TMPDIR. The build is deterministic: the same source and zig give the
// same bytes on any host.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = join(ROOT, "assets", "windows-launcher");
const SOURCE = join(ASSETS, "launcher.c");
const PIN_FILE = join(ASSETS, "pins.json");
const ZIG_VERSION = "0.17.1";
const ZIG_RELEASES = {
	"linux-x64": ["x86_64-linux", "3581863e3cbcfd0fce0efc682ce7e9e93da96668a977791d356a26d2a7e9b17a"],
	"linux-arm64": ["aarch64-linux", "a1546d5646eb184437918d6635ca6b762a0e889eac09cef720ee7a1ed3fe7795"],
	"darwin-x64": ["x86_64-macos", "9af07b20319fbd0c92ee46ad23e81d6a782b1aaea2cfb8dcbff35f1d2c7ddbb7"],
	"darwin-arm64": ["aarch64-macos", "75f1bc7a1e9852f17ec9a0c1895f767c4ec56d46bc8a834920eece1d0359dd8d"],
};
const TARGETS = { x64: "x86_64-windows-gnu", arm64: "aarch64-windows-gnu" };

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const assetPath = (arch) => join(ASSETS, `win32-${arch}`, "launcher.exe");

function fail(message) {
	process.stderr.write(`build-windows-launcher: ${message}\n`);
	process.exit(1);
}

function readPins() {
	const recorded = existsSync(PIN_FILE) ? JSON.parse(readFileSync(PIN_FILE, "utf8")) : {};
	const pins = {};
	for (const arch of Object.keys(TARGETS)) {
		const pin = recorded[arch];
		pins[arch] = typeof pin === "string" && /^[0-9a-f]{64}$/.test(pin) ? pin : "missing";
	}
	return pins;
}

async function pinnedZig(scratch) {
	const release = ZIG_RELEASES[`${process.platform}-${process.arch}`];
	if (release === undefined) fail(`no pinned zig for ${process.platform}-${process.arch}; pass --zig <path>`);
	const [name, digest] = release;
	const directory = join(tmpdir(), `clio-coder-zig-${ZIG_VERSION}-${name}`);
	const zig = join(directory, `zig-${name}-${ZIG_VERSION}`, "zig");
	if (existsSync(zig)) return zig;
	const url = `https://ziglang.org/download/${ZIG_VERSION}/zig-${name}-${ZIG_VERSION}.tar.xz`;
	process.stderr.write(`build-windows-launcher: downloading ${url}\n`);
	const response = await fetch(url);
	if (!response.ok) fail(`${url}: HTTP ${response.status}`);
	const bytes = Buffer.from(await response.arrayBuffer());
	if (sha256(bytes) !== digest) fail(`${url} does not match its pinned SHA-256`);
	const archive = join(scratch, "zig.tar.xz");
	writeFileSync(archive, bytes);
	mkdirSync(directory, { recursive: true });
	execFileSync("tar", ["-xJf", archive, "-C", directory], { stdio: "inherit" });
	return zig;
}

function build(zig, arch, output, cache) {
	const include = join(dirname(zig), "lib", "libc", "include", "any-windows-any");
	const args = [
		"cc",
		"-target",
		TARGETS[arch],
		"-Os",
		"-ffreestanding",
		"-fno-stack-protector",
		"-nostdlib",
		"-isystem",
		include,
		"-Wall",
		"-Wextra",
		"-Werror",
		"-Wl,--entry=launch",
		"-Wl,--subsystem,console",
		"-lkernel32",
		"-o",
		output,
		SOURCE,
	];
	// The zig caches stay in scratch, never in the operator's home.
	const env = { ...process.env, ZIG_GLOBAL_CACHE_DIR: cache, ZIG_LOCAL_CACHE_DIR: cache };
	execFileSync(zig, args, { env, stdio: "inherit" });
	return readFileSync(output);
}

async function main() {
	const argv = process.argv.slice(2);
	const mode = argv.find((value) => ["--verify-pins", "--check", "--write"].includes(value));
	if (mode === undefined) fail("pass --verify-pins, --check or --write");
	const zigFlag = argv.indexOf("--zig");
	const pins = readPins();

	if (mode === "--verify-pins") {
		for (const [arch, pin] of Object.entries(pins)) {
			const actual = existsSync(assetPath(arch)) ? sha256(readFileSync(assetPath(arch))) : "missing";
			if (actual !== pin) fail(`${assetPath(arch)} is ${actual}, pinned ${pin}`);
		}
		process.stdout.write("windows launchers match their pins\n");
		return;
	}

	const scratch = mkdtempSync(join(tmpdir(), "clio-coder-windows-launcher-"));
	try {
		const zig = zigFlag >= 0 ? resolve(argv[zigFlag + 1] ?? fail("--zig needs a path")) : await pinnedZig(scratch);
		const version = execFileSync(zig, ["version"], { encoding: "utf8" }).trim();
		if (version !== ZIG_VERSION) fail(`zig ${version} found; the launchers are pinned to zig ${ZIG_VERSION}`);
		let mismatched = false;
		for (const arch of Object.keys(TARGETS)) {
			const built = build(zig, arch, join(scratch, `launcher-${arch}.exe`), join(scratch, "cache"));
			const digest = sha256(built);
			if (mode === "--write") {
				mkdirSync(dirname(assetPath(arch)), { recursive: true });
				writeFileSync(assetPath(arch), built);
				process.stdout.write(`${arch}: "${digest}" (${built.length} bytes)\n`);
				pins[arch] = digest;
				continue;
			}
			const committed = existsSync(assetPath(arch)) ? readFileSync(assetPath(arch)) : null;
			if (committed === null || !committed.equals(built) || digest !== pins[arch]) {
				mismatched = true;
				process.stderr.write(
					`build-windows-launcher: ${arch} rebuilt ${digest}, committed ${committed === null ? "missing" : sha256(committed)}, pinned ${pins[arch]}\n`,
				);
			}
		}
		if (mode === "--write") writeFileSync(PIN_FILE, `${JSON.stringify(pins, null, "\t")}\n`);
		if (mismatched) process.exit(1);
		if (mode === "--check") process.stdout.write("windows launchers rebuild byte for byte and match their pins\n");
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

await main();
