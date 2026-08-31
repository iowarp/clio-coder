/**
 * The pinned external-tool registry: table shape, checksum-mismatch refusal,
 * and the resolution ladder.
 *
 * The three properties pinned here are the ones a careless pin bump breaks.
 * Every declared platform carries a checksum, because a platform without one
 * would turn "no asset for your machine" into an install that fails looking
 * like tampering. A mismatched download writes nothing, because the whole point
 * of vendoring a binary by hash is that an unverified one never reaches disk.
 * And the ladder prefers a PATH copy only while it clears the pin's floor,
 * because Clio drives surfaces older releases do not have.
 */

import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { deflateRawSync, gzipSync } from "node:zlib";
import {
	compareVersions,
	describeFloorRejection,
	describeResolution,
	installedToolVersions,
	installPinnedTool,
	PINNED_TOOLS,
	type PinnedTool,
	parseVersion,
	pruneSupersededVersions,
	removeTool,
	resetVersionProbeCache,
	resolveEntryBinary,
	resolveToolBinary,
	satisfiesMinimum,
	type ToolStatus,
	toolVersionDir,
} from "../../src/domains/toolchain/index.js";
import { resolveBinary } from "../../src/tools/executables.js";

const SEMVER = /^\d+\.\d+\.\d+$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const FOUR_NATIVE_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];

describe("toolchain registry table", () => {
	it("gives every entry a version, a license, binaries, and a PATH floor", () => {
		ok(PINNED_TOOLS.length >= 3, "the cycle pins herdr, yazi, and croc");
		const ids = PINNED_TOOLS.map((entry) => entry.id);
		deepStrictEqual(new Set(ids).size, ids.length, "tool ids are unique");
		for (const entry of PINNED_TOOLS) {
			match(entry.version, SEMVER, `${entry.id} version is a dotted triple`);
			match(entry.minimumVersion, SEMVER, `${entry.id} PATH floor is a dotted triple`);
			ok(entry.license.length > 0, `${entry.id} names a license`);
			ok(entry.binaries.length > 0, `${entry.id} names at least one binary`);
			ok(entry.binaries.includes(entry.primaryBinary), `${entry.id} primary binary is one of its binaries`);
			ok(entry.versionArgs.length > 0, `${entry.id} says how to ask for a version`);
			ok(compareVersions(entry.version, entry.minimumVersion) >= 0, `${entry.id} pin is not older than its own floor`);
		}
	});

	it("pins the three tools this cycle committed to, with their licenses", () => {
		const byId = new Map(PINNED_TOOLS.map((entry) => [entry.id, entry]));
		strictEqual(byId.get("herdr")?.license, "Apache-2.0");
		strictEqual(byId.get("yazi")?.license, "MIT");
		strictEqual(byId.get("croc")?.license, "MIT");
	});

	it("declares every native Linux and macOS platform published for the pins", () => {
		const byId = new Map(PINNED_TOOLS.map((entry) => [entry.id, entry]));
		for (const id of ["herdr", "yazi", "croc"]) {
			const entry = byId.get(id);
			ok(entry !== undefined, `${id} is pinned`);
			deepStrictEqual(Object.keys(entry.downloads).sort(), FOUR_NATIVE_PLATFORMS, `${id} has all four assets`);
		}
	});

	it("carries a well-formed url and sha256 for every declared platform and side document", () => {
		for (const entry of PINNED_TOOLS) {
			const platforms = Object.entries(entry.downloads);
			ok(platforms.length > 0, `${entry.id} declares at least one platform`);
			for (const [platform, download] of platforms) {
				ok(download !== undefined, `${entry.id}/${platform} has a download`);
				match(download.sha256, SHA256_HEX, `${entry.id}/${platform} sha256 is a hex digest`);
				ok(download.url.startsWith("https://"), `${entry.id}/${platform} downloads over https`);
				ok(download.url.includes(entry.version), `${entry.id}/${platform} url names the pinned version`);
				const memberNames = Object.keys(download.binaryMembers);
				ok(memberNames.length > 0, `${entry.id}/${platform} names its binaries inside the asset`);
				for (const name of memberNames) {
					ok(entry.binaries.includes(name), `${entry.id}/${platform} member ${name} is a declared binary`);
				}
				if (download.archive === "raw") {
					strictEqual(memberNames.length, 1, `${entry.id}/${platform} raw asset is exactly one binary`);
				}
			}
			for (const doc of entry.documents) {
				match(doc.sha256, SHA256_HEX, `${entry.id} document ${doc.name} sha256 is a hex digest`);
				ok(doc.url.startsWith("https://"), `${entry.id} document ${doc.name} downloads over https`);
			}
		}
	});

	it("ships license text with every install, from the asset or beside it", () => {
		for (const entry of PINNED_TOOLS) {
			for (const [platform, download] of Object.entries(entry.downloads)) {
				if (download === undefined) continue;
				const fromAsset = download.documentMembers.some((member) => member.split("/").pop() === "LICENSE");
				const fromSide = entry.documents.some((doc) => doc.name === "LICENSE");
				ok(fromAsset || fromSide, `${entry.id}/${platform} places a LICENSE beside the binary`);
			}
		}
	});
});

describe("toolchain version comparison", () => {
	it("reads a version out of each upstream's --version shape", () => {
		strictEqual(parseVersion("herdr 0.8.2"), "0.8.2");
		strictEqual(parseVersion("croc version 11.3.6"), "11.3.6");
		strictEqual(parseVersion("Yazi\n    Version: 26.8.15 (1f3588d 2026-08-15)\n"), "26.8.15");
		strictEqual(parseVersion("no version here"), null);
	});

	it("treats an unreadable version as failing every floor", () => {
		strictEqual(satisfiesMinimum(null, "0.0.1"), false);
		strictEqual(satisfiesMinimum("11.3.6", "11.0.0"), true);
		strictEqual(satisfiesMinimum("10.9.9", "11.0.0"), false);
		strictEqual(satisfiesMinimum("0.8.2", "0.8.2"), true);
	});
});

describe("toolchain install", () => {
	let root: string;

	before(() => {
		root = mkdtempSync(join(tmpdir(), "clio-toolchain-install-"));
	});
	after(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("refuses an asset whose checksum does not match the pin, and writes nothing", async () => {
		const entry = fakeEntry({ sha256: "0".repeat(64) });
		const result = await installPinnedTool(entry, {
			root,
			platform: "linux-x64",
			fetch: async () => Buffer.from("payload that does not hash to the pin"),
		});
		strictEqual(result.ok, false);
		match(result.message, /checksum mismatch/);
		match(result.message, /Nothing was written/);
		strictEqual(existsSync(join(root, entry.id)), false, "no directory is created for a refused install");
	});

	it("refuses a side document whose checksum does not match, leaving the version directory absent", async () => {
		const asset = Buffer.from("#!/bin/sh\necho fake\n");
		const entry = fakeEntry({ sha256: hash(asset) });
		const result = await installPinnedTool(
			{
				...entry,
				id: "fake-doc",
				documents: [{ name: "LICENSE", url: "https://example.invalid/LICENSE", sha256: "1".repeat(64) }],
			},
			{
				root,
				platform: "linux-x64",
				fetch: async (url) => (url.endsWith("LICENSE") ? Buffer.from("MIT") : asset),
			},
		);
		strictEqual(result.ok, false);
		match(result.message, /checksum mismatch/);
		strictEqual(existsSync(join(root, "fake-doc", entry.version)), false);
	});

	it("installs a raw asset with its side license, executable, under <root>/<id>/<version>", async () => {
		const asset = Buffer.from("#!/bin/sh\necho raw\n");
		const license = Buffer.from("Apache License 2.0 text\n");
		const entry: PinnedTool = {
			...fakeEntry({ sha256: hash(asset) }),
			id: "fake-raw",
			documents: [{ name: "LICENSE", url: "https://example.invalid/LICENSE", sha256: hash(license) }],
		};
		const result = await installPinnedTool(entry, {
			root,
			platform: "linux-x64",
			fetch: async (url) => (url.endsWith("LICENSE") ? license : asset),
		});
		ok(result.ok, result.message);
		strictEqual(result.skipped, false);
		const binary = join(root, "fake-raw", entry.version, "faketool");
		ok(existsSync(binary), "the binary landed in the version directory");
		strictEqual(readFileSync(binary, "utf8"), asset.toString("utf8"));
		ok(existsSync(join(root, "fake-raw", entry.version, "LICENSE")), "the license landed beside it");
		const manifest = JSON.parse(readFileSync(join(root, "fake-raw", entry.version, "clio-install.json"), "utf8"));
		strictEqual(manifest.sha256, hash(asset));
		strictEqual(manifest.license, "Apache-2.0");
	});

	it("unpacks a tar.gz asset and copies the license members out of it", async () => {
		const archive = gzipSync(
			Buffer.concat([
				tarBlock("croclike", Buffer.from("#!/bin/sh\necho croclike\n"), 0o755),
				tarBlock("LICENSE", Buffer.from("MIT text\n"), 0o644),
				Buffer.alloc(1024),
			]),
		);
		const entry: PinnedTool = {
			...fakeEntry({ sha256: hash(archive) }),
			id: "fake-tar",
			binaries: ["croclike"],
			primaryBinary: "croclike",
			downloads: {
				"linux-x64": {
					url: "https://example.invalid/asset.tar.gz",
					sha256: hash(archive),
					archive: "tar.gz",
					binaryMembers: { croclike: "croclike" },
					documentMembers: ["LICENSE"],
				},
			},
		};
		const result = await installPinnedTool(entry, { root, platform: "linux-x64", fetch: async () => archive });
		ok(result.ok, result.message);
		ok(existsSync(join(root, "fake-tar", entry.version, "croclike")));
		strictEqual(readFileSync(join(root, "fake-tar", entry.version, "LICENSE"), "utf8"), "MIT text\n");
	});

	it("unpacks a deflated zip asset, keeping the executable bit and the license", async () => {
		const archive = buildZip([
			{ name: "bundle/zipped", content: Buffer.from("#!/bin/sh\necho zipped\n"), mode: 0o755 },
			{ name: "bundle/LICENSE", content: Buffer.from("MIT text\n"), mode: 0o644 },
		]);
		const entry: PinnedTool = {
			...fakeEntry({ sha256: hash(archive) }),
			id: "fake-zip",
			binaries: ["zipped"],
			primaryBinary: "zipped",
			downloads: {
				"linux-x64": {
					url: "https://example.invalid/asset.zip",
					sha256: hash(archive),
					archive: "zip",
					binaryMembers: { zipped: "bundle/zipped" },
					documentMembers: ["bundle/LICENSE"],
				},
			},
		};
		const result = await installPinnedTool(entry, { root, platform: "linux-x64", fetch: async () => archive });
		ok(result.ok, result.message);
		const binary = join(root, "fake-zip", entry.version, "zipped");
		strictEqual(readFileSync(binary, "utf8"), "#!/bin/sh\necho zipped\n");
		strictEqual(statSync(binary).mode & 0o111, 0o111, "the installed binary is executable");
		strictEqual(readFileSync(join(root, "fake-zip", entry.version, "LICENSE"), "utf8"), "MIT text\n");
	});

	it("refuses an asset that does not contain the member the registry names", async () => {
		const archive = buildZip([{ name: "bundle/other", content: Buffer.from("x"), mode: 0o755 }]);
		const entry: PinnedTool = {
			...fakeEntry({ sha256: hash(archive) }),
			id: "fake-missing",
			binaries: ["zipped"],
			primaryBinary: "zipped",
			downloads: {
				"linux-x64": {
					url: "https://example.invalid/asset.zip",
					sha256: hash(archive),
					archive: "zip",
					binaryMembers: { zipped: "bundle/zipped" },
					documentMembers: [],
				},
			},
		};
		const result = await installPinnedTool(entry, { root, platform: "linux-x64", fetch: async () => archive });
		strictEqual(result.ok, false);
		match(result.message, /does not contain bundle\/zipped/);
		strictEqual(existsSync(join(root, "fake-missing", entry.version)), false);
	});

	it("does not re-download a version that is already installed", async () => {
		const asset = Buffer.from("#!/bin/sh\necho raw\n");
		const entry: PinnedTool = {
			...fakeEntry({ sha256: hash(asset) }),
			id: "fake-raw",
			documents: [],
		};
		let fetches = 0;
		const result = await installPinnedTool(entry, {
			root,
			platform: "linux-x64",
			fetch: async () => {
				fetches += 1;
				return asset;
			},
		});
		ok(result.ok, result.message);
		strictEqual(result.skipped, true);
		strictEqual(fetches, 0, "an installed version costs no network");
	});

	it("puts the previous version back when a --force replacement fails to land", async () => {
		const original = Buffer.from("#!/bin/sh\necho original\n");
		const replacement = Buffer.from("#!/bin/sh\necho replacement\n");
		const base: PinnedTool = { ...fakeEntry({ sha256: hash(original) }), id: "fake-force", documents: [] };
		const first = await installPinnedTool(base, { root, platform: "linux-x64", fetch: async () => original });
		ok(first.ok, first.message);

		const toolDir = join(root, "fake-force");
		const versionDir = join(toolDir, base.version);
		let forceReads = 0;
		const second = await installPinnedTool(
			{ ...fakeEntry({ sha256: hash(replacement) }), id: "fake-force", documents: [] },
			{
				root,
				platform: "linux-x64",
				fetch: async () => replacement,
				// Read once when the already-installed check runs and again just
				// before the renames. Deleting the staging directory on that second
				// read makes the rename into place fail, which is exactly the window
				// the old version has to survive.
				get force(): boolean {
					forceReads += 1;
					if (forceReads === 2) {
						for (const name of readdirSync(toolDir)) {
							if (name.startsWith(".") && name.includes(".incomplete-")) {
								rmSync(join(toolDir, name), { recursive: true, force: true });
							}
						}
					}
					return true;
				},
			},
		);

		strictEqual(second.ok, false);
		match(second.message, /install failed/);
		ok(existsSync(versionDir), "the version directory the operator had is still there");
		strictEqual(readFileSync(join(versionDir, "faketool"), "utf8"), original.toString("utf8"));
		deepStrictEqual(readdirSync(toolDir), [base.version], "no staging or retired directory is left behind");
	});

	it("reports a platform the registry has no asset for instead of guessing one", async () => {
		const result = await installPinnedTool(fakeEntry({ sha256: "0".repeat(64) }), {
			root,
			platform: "win32-x64",
			fetch: async () => Buffer.alloc(0),
		});
		strictEqual(result.ok, false);
		match(result.message, /no pinned asset for win32-x64/);
	});
});

/**
 * A pin bump used to leave the version it superseded on disk forever: nothing
 * resolved it, nothing deleted it, and only an operator who went looking under
 * the data root would ever know. Installing now sweeps, so a tool holds the
 * pinned version and nothing else.
 */
describe("toolchain install pruning", () => {
	let root: string;

	before(() => {
		root = mkdtempSync(join(tmpdir(), "clio-toolchain-prune-"));
	});
	after(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("keeps only the pinned version when a bump lands beside an older one", async () => {
		const old = Buffer.from("#!/bin/sh\necho old\n");
		const fresh = Buffer.from("#!/bin/sh\necho fresh\n");
		const first = await installPinnedTool(versionedEntry("bumped", "1.0.0", old), {
			root,
			platform: "linux-x64",
			fetch: async () => old,
		});
		ok(first.ok, first.message);
		deepStrictEqual(first.pruned, [], "the first install of a tool supersedes nothing");

		const second = await installPinnedTool(versionedEntry("bumped", "2.0.0", fresh), {
			root,
			platform: "linux-x64",
			fetch: async () => fresh,
		});
		ok(second.ok, second.message);
		deepStrictEqual(second.pruned, ["1.0.0"], "the superseded version is named in the result");
		match(second.message, /pruned 1\.0\.0/);
		deepStrictEqual(installedToolVersions("bumped", { root }), ["2.0.0"]);
		strictEqual(existsSync(join(root, "bumped", "1.0.0")), false, "the old version directory is gone");
		strictEqual(readFileSync(join(root, "bumped", "2.0.0", "bumped"), "utf8"), fresh.toString("utf8"));
	});

	it("prunes leftovers even when the pinned version was already installed", async () => {
		const payload = Buffer.from("#!/bin/sh\necho already\n");
		const entry = versionedEntry("leftover", "3.0.0", payload);
		const first = await installPinnedTool(entry, { root, platform: "linux-x64", fetch: async () => payload });
		ok(first.ok, first.message);
		// A machine that bumped pins before pruning existed looks exactly like this.
		mkdirSync(join(root, "leftover", "2.9.0"), { recursive: true });
		writeFileSync(join(root, "leftover", "2.9.0", "leftover"), payload);

		let fetches = 0;
		const second = await installPinnedTool(entry, {
			root,
			platform: "linux-x64",
			fetch: async () => {
				fetches += 1;
				return payload;
			},
		});
		ok(second.ok, second.message);
		strictEqual(second.skipped, true, "the pinned version was already there");
		strictEqual(fetches, 0, "a repair costs no network");
		deepStrictEqual(second.pruned, ["2.9.0"]);
		deepStrictEqual(installedToolVersions("leftover", { root }), ["3.0.0"]);
	});

	it("leaves a concurrent installer's staging directory alone", async () => {
		const payload = Buffer.from("#!/bin/sh\necho staged\n");
		const entry = versionedEntry("staged", "1.0.0", payload);
		const first = await installPinnedTool(entry, { root, platform: "linux-x64", fetch: async () => payload });
		ok(first.ok, first.message);
		const staging = join(root, "staged", ".9.9.9.incomplete-4242-abc");
		mkdirSync(staging, { recursive: true });

		const outcome = pruneSupersededVersions("staged", "1.0.0", { root });
		deepStrictEqual(outcome.removed, [], "a dot-prefixed staging directory is not a version");
		ok(existsSync(staging), "the directory another installer is filling survives the prune");
		deepStrictEqual(installedToolVersions("staged", { root }), ["1.0.0"]);
	});
});

/**
 * `tools remove` is the cleanup verb the domain shipped without. Everything it
 * unlinks lives under `<root>/<id>`, which Clio created by downloading it, so
 * the worst outcome of a mistake is a re-download of checksum-pinned bytes.
 */
describe("toolchain remove", () => {
	let root: string;

	before(() => {
		root = mkdtempSync(join(tmpdir(), "clio-toolchain-remove-"));
	});
	after(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("deletes every vendored version of a known tool, and the tool directory with them", () => {
		vendorVersion(root, "croc", "11.3.6", "croc");
		vendorVersion(root, "croc", "10.0.1", "croc");
		vendorVersion(root, "yazi", "26.8.15", "yazi");

		const result = removeTool("croc", { root });
		ok(result.ok, result.message);
		deepStrictEqual(result.removed, ["10.0.1", "11.3.6"]);
		match(result.message, /removed croc 10\.0\.1, 11\.3\.6/);
		strictEqual(existsSync(join(root, "croc")), false, "the tool directory goes with its last version");
		deepStrictEqual(installedToolVersions("yazi", { root }), ["26.8.15"], "another tool is untouched");
	});

	it("refuses an id the registry does not know instead of deleting a path built from it", () => {
		mkdirSync(join(root, "not-a-tool"), { recursive: true });
		const result = removeTool("not-a-tool", { root });
		strictEqual(result.ok, false);
		match(result.message, /unknown tool: not-a-tool/);
		deepStrictEqual(result.removed, []);
		ok(existsSync(join(root, "not-a-tool")), "an unknown id unlinks nothing");
	});

	it("is a successful no-op with a clear message when nothing is installed", () => {
		const result = removeTool("herdr", { root });
		ok(result.ok, "the state the operator asked for already holds");
		deepStrictEqual(result.removed, []);
		match(result.message, /herdr is not installed under .*herdr; nothing to remove/);
	});

	it("keeps a staging directory it cannot claim, and still removes every version", () => {
		vendorVersion(root, "herdr", "0.8.2", "herdr");
		const staging = join(root, "herdr", ".0.9.0.incomplete-77-zz");
		mkdirSync(staging, { recursive: true });

		const result = removeTool("herdr", { root });
		ok(result.ok, result.message);
		deepStrictEqual(result.removed, ["0.8.2"]);
		ok(existsSync(staging), "a live installer's staging directory is not swept up");
		deepStrictEqual(installedToolVersions("herdr", { root }), []);
		rmSync(join(root, "herdr"), { recursive: true, force: true });
	});
});

/**
 * The floors stay conservative, so the rejection has to be legible: every
 * render of one names the binary found, the version it reported, and the floor
 * it missed, and offers the install command exactly where installing would
 * change something.
 */
describe("toolchain floor honesty", () => {
	it("names the path, the version found, and the floor of a rejected PATH copy", () => {
		const status = statusFor({ candidate: { path: "/usr/bin/herdr", version: "0.7.5", satisfiesMinimum: false } });
		strictEqual(describeFloorRejection(status), "PATH copy /usr/bin/herdr is 0.7.5, below the 0.8.2 floor");
	});

	it("never reports a rejected PATH copy as an absent binary, and offers the remedy", () => {
		const detail = describeResolution(
			statusFor({ candidate: { path: "/usr/bin/herdr", version: "0.7.5", satisfiesMinimum: false } }),
		);
		match(detail, /PATH copy \/usr\/bin\/herdr is 0\.7\.5, below the 0\.8\.2 floor/);
		match(detail, /nothing is vendored/);
		match(detail, /clio-coder tools install herdr/);
		strictEqual(detail.startsWith("not found"), false, "the copy was found and rejected, not missing");
	});

	it("repeats the rejection beside a vendored copy but offers no remedy that changes nothing", () => {
		const detail = describeResolution(
			statusFor({
				source: "vendored",
				vendoredPath: "/data/tools/herdr/0.8.2/herdr",
				candidate: { path: "/usr/bin/herdr", version: "0.7.5", satisfiesMinimum: false },
			}),
		);
		match(detail, /vendored \/data\/tools\/herdr\/0\.8\.2\/herdr \(0\.8\.2\)/);
		match(detail, /below the 0\.8\.2 floor, so Clio runs the vendored copy/);
		strictEqual(detail.includes("tools install"), false, "installing again would change nothing");
	});

	it("says the version was unreadable rather than rendering an empty one", () => {
		const status = statusFor({ candidate: { path: "/usr/bin/herdr", version: null, satisfiesMinimum: false } });
		strictEqual(
			describeFloorRejection(status),
			"PATH copy /usr/bin/herdr is an unreadable version, below the 0.8.2 floor",
		);
		match(describeResolution(status), /an unreadable version/);
	});

	it("keeps the rejection on a platform with no pinned asset and names no dead-end command", () => {
		const detail = describeResolution(
			statusFor({
				supported: false,
				platform: null,
				candidate: { path: "/usr/bin/herdr", version: "0.7.5", satisfiesMinimum: false },
			}),
		);
		match(detail, /no pinned asset for this platform/);
		match(detail, /below the 0\.8\.2 floor/);
		strictEqual(detail.includes("tools install"), false, "there is no asset to install here");
	});

	it("says nothing about a floor when the PATH copy cleared it", () => {
		const status = statusFor({
			source: "path",
			binaryPath: "/usr/bin/herdr",
			version: "0.9.0",
			candidate: { path: "/usr/bin/herdr", version: "0.9.0", satisfiesMinimum: true },
		});
		strictEqual(describeFloorRejection(status), null);
		strictEqual(describeResolution(status), "PATH /usr/bin/herdr (0.9.0, pin 0.8.2)");
	});
});

describe("toolchain resolution ladder", () => {
	let scratch: string;
	let pathDir: string;
	let dataDir: string;
	const originalPath = process.env.PATH;
	const originalDataDir = process.env.CLIO_CODER_DATA_DIR;

	const entry: PinnedTool = {
		id: "laddertool",
		version: "2.0.0",
		summary: "fixture",
		homepage: "https://example.invalid",
		license: "MIT",
		binaries: ["laddertool"],
		primaryBinary: "laddertool",
		minimumVersion: "2.0.0",
		versionArgs: ["--version"],
		downloads: {},
		documents: [],
	};

	before(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-toolchain-ladder-"));
		pathDir = join(scratch, "bin");
		// Under CLIO_CODER_HOME when the harness set one, so the home-prefix
		// guardrail in src/core/init.ts stays satisfied for anything this file
		// loads that resolves Clio's roots.
		dataDir = join(process.env.CLIO_CODER_HOME ?? scratch, "toolchain-data");
		mkdirSync(pathDir, { recursive: true });
		mkdirSync(dataDir, { recursive: true });
	});
	after(() => {
		rmSync(scratch, { recursive: true, force: true });
		resetVersionProbeCache();
	});

	// The swap is per-test rather than per-suite so nothing declared after this
	// file's last suite can inherit a stubbed PATH or data directory.
	beforeEach(() => {
		process.env.CLIO_CODER_DATA_DIR = dataDir;
		process.env.PATH = pathDir;
	});
	afterEach(() => {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		if (originalDataDir === undefined) delete process.env.CLIO_CODER_DATA_DIR;
		else process.env.CLIO_CODER_DATA_DIR = originalDataDir;
	});

	it("resolves to none with nothing on PATH and nothing vendored", () => {
		resetVersionProbeCache();
		const resolution = resolveEntryBinary(entry, "laddertool");
		strictEqual(resolution.source, "none");
		strictEqual(resolution.binaryPath, null);
		strictEqual(resolution.pathCandidate, null);
	});

	it("resolves to the vendored copy when the PATH copy is below the floor", () => {
		writeFakeBinary(join(pathDir, "laddertool"), "laddertool 1.4.0");
		vendor(dataDir, entry, "laddertool");
		resetVersionProbeCache();
		const resolution = resolveEntryBinary(entry, "laddertool");
		strictEqual(resolution.source, "vendored");
		strictEqual(resolution.binaryPath, join(dataDir, "tools", entry.id, entry.version, "laddertool"));
		strictEqual(resolution.pathCandidate?.version, "1.4.0");
		strictEqual(resolution.pathCandidate?.satisfiesMinimum, false);
	});

	it("prefers the PATH copy once it clears the floor, even with a vendored copy present", () => {
		writeFakeBinary(join(pathDir, "laddertool"), "laddertool 2.1.0");
		resetVersionProbeCache();
		const resolution = resolveEntryBinary(entry, "laddertool");
		strictEqual(resolution.source, "path");
		strictEqual(resolution.binaryPath, join(pathDir, "laddertool"));
		strictEqual(resolution.version, "2.1.0");
		ok(resolution.vendoredPath !== null, "the vendored copy is still reported, just not chosen");
	});

	it("routes a registered binary name through the ladder and an unknown one through PATH", () => {
		writeFakeBinary(join(pathDir, "notpinned"), "notpinned 0.0.1");
		resetVersionProbeCache();
		strictEqual(resolveBinary("notpinned"), join(pathDir, "notpinned"));
		strictEqual(resolveBinary("definitely-not-installed-anywhere"), null);
		const known = resolveToolBinary("croc");
		strictEqual(known.entry?.id, "croc");
		strictEqual(known.source, "none", "croc is neither on this stub PATH nor vendored");
	});

	it("points the vendor root at the data directory, versioned per pin", () => {
		strictEqual(toolVersionDir("croc", "11.3.6"), join(dataDir, "tools", "croc", "11.3.6"));
	});
});

function fakeEntry(overrides: { sha256: string }): PinnedTool {
	return {
		id: "faketool",
		version: "1.2.3",
		summary: "fixture",
		homepage: "https://example.invalid",
		license: "Apache-2.0",
		binaries: ["faketool"],
		primaryBinary: "faketool",
		minimumVersion: "1.2.3",
		versionArgs: ["--version"],
		downloads: {
			"linux-x64": {
				url: "https://example.invalid/faketool",
				sha256: overrides.sha256,
				archive: "raw",
				binaryMembers: { faketool: "" },
				documentMembers: [],
			},
		},
		documents: [],
	};
}

function hash(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** A raw-asset fixture whose id and version the caller picks, for pin bumps. */
function versionedEntry(id: string, version: string, payload: Buffer): PinnedTool {
	return {
		id,
		version,
		summary: "fixture",
		homepage: "https://example.invalid",
		license: "MIT",
		binaries: [id],
		primaryBinary: id,
		minimumVersion: version,
		versionArgs: ["--version"],
		downloads: {
			"linux-x64": {
				url: `https://example.invalid/${id}-${version}`,
				sha256: hash(payload),
				archive: "raw",
				binaryMembers: { [id]: "" },
				documentMembers: [],
			},
		},
		documents: [],
	};
}

/** A vendored version directory placed by hand, the way an install leaves one. */
function vendorVersion(root: string, id: string, version: string, binary: string): void {
	const dir = join(root, id, version);
	mkdirSync(dir, { recursive: true });
	writeFakeBinary(join(dir, binary), `${binary} ${version}`);
	writeFileSync(join(dir, "LICENSE"), "fixture license\n");
}

/**
 * A `ToolStatus` built by hand for the renderers.
 *
 * The floor sentences depend only on the status shape, so pinning them here
 * costs no filesystem and no PATH stub, and covers combinations (an unsupported
 * platform carrying a rejected PATH copy) that are awkward to stage on disk.
 */
function statusFor(overrides: {
	source?: "path" | "vendored" | "none";
	binaryPath?: string | null;
	version?: string | null;
	vendoredPath?: string | null;
	supported?: boolean;
	platform?: ToolStatus["platform"];
	candidate: { path: string; version: string | null; satisfiesMinimum: boolean } | null;
}): ToolStatus {
	const entry: PinnedTool = {
		...versionedEntry("herdr", "0.8.2", Buffer.from("x")),
		license: "Apache-2.0",
	};
	const source = overrides.source ?? "none";
	const vendoredPath = overrides.vendoredPath ?? null;
	return {
		id: entry.id,
		version: entry.version,
		license: entry.license,
		platform: overrides.platform === undefined ? "linux-x64" : overrides.platform,
		supported: overrides.supported ?? true,
		installed: vendoredPath !== null,
		installDir: `/data/tools/${entry.id}/${entry.version}`,
		resolution: {
			source,
			binaryPath: overrides.binaryPath ?? vendoredPath,
			version: overrides.version ?? (source === "vendored" ? entry.version : null),
			entry,
			pathCandidate: overrides.candidate,
			vendoredPath,
		},
	};
}

/** A shell stub that answers `--version` the way the real binary would. */
function writeFakeBinary(path: string, versionLine: string): void {
	writeFileSync(path, `#!/bin/sh\necho "${versionLine}"\n`);
	chmodSync(path, 0o755);
}

function vendor(dataDir: string, entry: PinnedTool, binary: string): void {
	const dir = join(dataDir, "tools", entry.id, entry.version);
	mkdirSync(dir, { recursive: true });
	writeFakeBinary(join(dir, binary), `${binary} ${entry.version}`);
}

/**
 * A minimal deflated zip: one local header and one central directory entry per
 * file, then the end-of-central-directory record. Enough to exercise the real
 * reader on the format the yazi asset ships in.
 */
function buildZip(files: ReadonlyArray<{ name: string; content: Buffer; mode: number }>): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const file of files) {
		const nameBytes = Buffer.from(file.name, "utf8");
		const deflated = deflateRawSync(file.content);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(8, 8);
		local.writeUInt32LE(0, 14);
		local.writeUInt32LE(deflated.length, 18);
		local.writeUInt32LE(file.content.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		locals.push(Buffer.concat([local, nameBytes, deflated]));

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(8, 10);
		central.writeUInt32LE(0, 16);
		central.writeUInt32LE(deflated.length, 20);
		central.writeUInt32LE(file.content.length, 24);
		central.writeUInt16LE(nameBytes.length, 28);
		central.writeUInt32LE(((file.mode | 0o100000) << 16) >>> 0, 38);
		central.writeUInt32LE(offset, 42);
		centrals.push(Buffer.concat([central, nameBytes]));
		offset += 30 + nameBytes.length + deflated.length;
	}
	const centralBytes = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(files.length, 8);
	eocd.writeUInt16LE(files.length, 10);
	eocd.writeUInt32LE(centralBytes.length, 12);
	eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, centralBytes, eocd]);
}

/** One ustar header block plus padded content. */
function tarBlock(name: string, content: Buffer, mode: number): Buffer {
	const header = Buffer.alloc(512);
	header.write(name, 0, 100, "utf8");
	header.write(mode.toString(8).padStart(7, "0"), 100, 8, "ascii");
	header.write("0000000", 108, 8, "ascii");
	header.write("0000000", 116, 8, "ascii");
	header.write(`${content.length.toString(8).padStart(11, "0")} `, 124, 12, "ascii");
	header.write("00000000000 ", 136, 12, "ascii");
	header.write(" ".repeat(8), 148, 8, "ascii");
	header.write("0", 156, 1, "ascii");
	header.write("ustar\0", 257, 6, "ascii");
	header.write("00", 263, 2, "ascii");
	let checksum = 0;
	for (const byte of header) checksum += byte;
	header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
	const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
	return Buffer.concat([header, content, padding]);
}
