#!/usr/bin/env node
// Builds and checks the native Windows git launchers in assets/git-shim/.
//
//   node scripts/build-git-shim.mjs --verify-pins   committed binaries match the pins in src/ (no compiler)
//   node scripts/build-git-shim.mjs --check         rebuild with the pinned zig and compare byte for byte
//   node scripts/build-git-shim.mjs --write         rebuild into assets/git-shim/ and print the pins
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
const SOURCE = join(ROOT, "assets", "git-shim", "launcher.c");
const PIN_FILE = join(ROOT, "src", "core", "git-shim-launcher.ts");
const ZIG_VERSION = "0.17.1";
const ZIG_RELEASES = {
	"linux-x64": ["x86_64-linux", "3581863e3cbcfd0fce0efc682ce7e9e93da96668a977791d356a26d2a7e9b17a"],
	"linux-arm64": ["aarch64-linux", "a1546d5646eb184437918d6635ca6b762a0e889eac09cef720ee7a1ed3fe7795"],
	"darwin-x64": ["x86_64-macos", "9af07b20319fbd0c92ee46ad23e81d6a782b1aaea2cfb8dcbff35f1d2c7ddbb7"],
	"darwin-arm64": ["aarch64-macos", "75f1bc7a1e9852f17ec9a0c1895f767c4ec56d46bc8a834920eece1d0359dd8d"],
};
const TARGETS = { x64: "x86_64-windows-gnu", arm64: "aarch64-windows-gnu" };

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const assetPath = (arch) => join(ROOT, "assets", "git-shim", `win32-${arch}`, "git.exe");

function fail(message) {
	process.stderr.write(`build-git-shim: ${message}\n`);
	process.exit(1);
}

function readPins() {
	const text = readFileSync(PIN_FILE, "utf8");
	const pins = {};
	for (const arch of Object.keys(TARGETS)) {
		const match = new RegExp(`\\b${arch}: "([0-9a-f]{64})"`).exec(text);
		if (match === null) fail(`no ${arch} pin in ${PIN_FILE}`);
		pins[arch] = match[1];
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
	process.stderr.write(`build-git-shim: downloading ${url}\n`);
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
		process.stdout.write("git launchers match their pins\n");
		return;
	}

	const scratch = mkdtempSync(join(tmpdir(), "clio-coder-git-shim-"));
	try {
		const zig = zigFlag >= 0 ? resolve(argv[zigFlag + 1] ?? fail("--zig needs a path")) : await pinnedZig(scratch);
		const version = execFileSync(zig, ["version"], { encoding: "utf8" }).trim();
		if (version !== ZIG_VERSION) fail(`zig ${version} found; the launchers are pinned to zig ${ZIG_VERSION}`);
		let mismatched = false;
		for (const arch of Object.keys(TARGETS)) {
			const built = build(zig, arch, join(scratch, `git-${arch}.exe`), join(scratch, "cache"));
			const digest = sha256(built);
			if (mode === "--write") {
				mkdirSync(dirname(assetPath(arch)), { recursive: true });
				writeFileSync(assetPath(arch), built);
				process.stdout.write(`${arch}: "${digest}" (${built.length} bytes)\n`);
				if (digest !== pins[arch]) {
					mismatched = true;
					process.stderr.write(`build-git-shim: update the ${arch} pin in ${PIN_FILE}\n`);
				}
				continue;
			}
			const committed = existsSync(assetPath(arch)) ? readFileSync(assetPath(arch)) : null;
			if (committed === null || !committed.equals(built) || digest !== pins[arch]) {
				mismatched = true;
				process.stderr.write(
					`build-git-shim: ${arch} rebuilt ${digest}, committed ${committed === null ? "missing" : sha256(committed)}, pinned ${pins[arch]}\n`,
				);
			}
		}
		if (mismatched) process.exit(1);
		if (mode === "--check") process.stdout.write("git launchers rebuild byte for byte and match their pins\n");
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

await main();
