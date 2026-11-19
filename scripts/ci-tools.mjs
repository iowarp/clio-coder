#!/usr/bin/env node
/**
 * ripgrep and fd for qualification, from pinned upstream release archives.
 *
 * CI used to `apt-get install ripgrep fd-find` in each test job. An Ubuntu mirror timeout failed
 * `ci (24)` before any test ran, and apt's versions (rg 14.1.0, fd 9.0.0 as `fdfind`) differed
 * from a developer's, while a machine without either tool skipped the search contracts silently.
 * Qualification now runs the same two binaries everywhere: each archive and each extracted binary
 * is checked against the SHA-256 recorded here, and the binaries are kept in a cache directory,
 * so only the first run after a pin change downloads anything.
 *
 * To move a pin: change the version, then record the SHA-256 of each archive (upstream publishes
 * them) and of the binary it contains.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SEARCH_TOOL_PINS = {
	rg: {
		version: "14.1.1",
		url: (target) => `https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-${target}.tar.gz`,
		member: (target) => `ripgrep-14.1.1-${target}/rg`,
		targets: {
			"linux-x64": {
				target: "x86_64-unknown-linux-musl",
				archive: "4cf9f2741e6c465ffdb7c26f38056a59e2a2544b51f7cc128ef28337eeae4d8e",
				binary: "f401154e2393f9002ac77e419f9ee5521c18f4f8cd3e32293972f493ba06fce7",
			},
			"linux-arm64": {
				target: "aarch64-unknown-linux-gnu",
				archive: "c827481c4ff4ea10c9dc7a4022c8de5db34a5737cb74484d62eb94a95841ab2f",
				binary: "e07d5c85fa9ca740ff4ab8bbac60a1e11c7a5ce242435f7820a03f7c20ef6276",
			},
		},
	},
	fd: {
		version: "10.3.0",
		url: (target) => `https://github.com/sharkdp/fd/releases/download/v10.3.0/fd-v10.3.0-${target}.tar.gz`,
		member: (target) => `fd-v10.3.0-${target}/fd`,
		targets: {
			"linux-x64": {
				target: "x86_64-unknown-linux-musl",
				archive: "2b6bfaae8c48f12050813c2ffe1884c61ea26e750d803df9c9114550a314cd14",
				binary: "9f48273b6c780a5f4f084ef30bc67d98cbd7d10c55c4605cf3a6ee29b741af87",
			},
			"linux-arm64": {
				target: "aarch64-unknown-linux-musl",
				archive: "996b9b1366433b211cb3bbedba91c9dbce2431842144d925428ead0adf32020b",
				binary: "d0fc407937b8a8aec44f3a80b4a08219ba61dde234590358abb168b44478d493",
			},
		},
	},
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function download(url) {
	let last;
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return Buffer.from(await response.arrayBuffer());
		} catch (error) {
			last = error;
			if (attempt < 3) await new Promise((done) => setTimeout(done, attempt * 2000));
		}
	}
	throw new Error(`could not download ${url}: ${last instanceof Error ? last.message : String(last)}`);
}

async function install(name, pin, spec, bin) {
	const path = join(bin, name);
	if (existsSync(path) && sha256(readFileSync(path)) === spec.binary) {
		// A copy restored from a CI artifact has the right bytes and no executable bit.
		chmodSync(path, 0o755);
		return path;
	}
	const archive = await download(pin.url(spec.target));
	if (sha256(archive) !== spec.archive)
		throw new Error(`${name} ${pin.version} archive does not match its pinned SHA-256; nothing was installed.`);
	// Extracted beside the destination and renamed into place, so two qualification legs
	// that install at once each see either no binary or a whole one.
	const scratch = mkdtempSync(join(bin, `.${name}-`));
	try {
		writeFileSync(join(scratch, "archive.tar.gz"), archive);
		const member = pin.member(spec.target);
		execFileSync("tar", ["-xzf", join(scratch, "archive.tar.gz"), "-C", scratch, member]);
		const extracted = join(scratch, member);
		if (sha256(readFileSync(extracted)) !== spec.binary)
			throw new Error(`${name} ${pin.version} binary does not match its pinned SHA-256; nothing was installed.`);
		chmodSync(extracted, 0o755);
		renameSync(extracted, path);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
	return path;
}

function onPath(name, env) {
	const probe = spawnSync(name, ["--version"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	return probe.error === undefined && probe.status === 0 ? probe.stdout.split("\n")[0].trim() : null;
}

/**
 * Makes rg and fd available and returns `{ bin, source, versions }`. On a pinned platform `bin` is a
 * directory holding exactly the pinned binaries, to put first on PATH. Elsewhere there is no pin, so
 * both tools must already be on PATH (`bin` is null) and their versions are reported as found.
 */
export async function ensureSearchTools(
	cache,
	{ platform = `${process.platform}-${process.arch}`, env = process.env } = {},
) {
	const pinned = Object.values(SEARCH_TOOL_PINS).every((pin) => pin.targets[platform]);
	if (!pinned) {
		const versions = { rg: onPath("rg", env), fd: onPath("fd", env) ?? onPath("fdfind", env) };
		const missing = Object.keys(versions).filter((name) => !versions[name]);
		if (missing.length)
			throw new Error(
				`Qualification needs ${missing.join(" and ")} on PATH: ${platform} has no pinned build, and without them the search contracts skip.`,
			);
		return { bin: null, source: "PATH", versions };
	}
	const bin = join(cache, platform);
	mkdirSync(bin, { recursive: true });
	const versions = {};
	for (const [name, pin] of Object.entries(SEARCH_TOOL_PINS)) {
		await install(name, pin, pin.targets[platform], bin);
		versions[name] = pin.version;
	}
	return { bin, source: "pinned", versions };
}

/** `env` with the pinned tools first on PATH. */
export function withSearchTools(env, tools) {
	return tools.bin ? { ...env, PATH: `${tools.bin}${delimiter}${env.PATH ?? ""}` } : env;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		const cache = process.argv[2];
		if (!cache) throw new Error("Usage: ci-tools.mjs <cache directory>");
		const tools = await ensureSearchTools(cache);
		console.log(
			`ci-tools: rg ${tools.versions.rg}, fd ${tools.versions.fd} (${tools.source}${tools.bin ? `, ${tools.bin}` : ""})`,
		);
	} catch (error) {
		console.error(`ci-tools: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
