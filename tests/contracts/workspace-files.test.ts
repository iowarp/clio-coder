import { deepStrictEqual, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { type Dir, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	enumerateWorkspaceFiles,
	enumerateWorkspaceFilesAsync,
	filterWorkspaceFileCandidates,
	WorkspaceEnumerationIncompleteError,
	WorkspaceEnumerationLimitError,
	type WorkspaceEnumerationOperation,
} from "../../src/core/workspace-files.js";
import { buildCodewiki, updateCodewikiPaths } from "../../src/domains/context/codewiki/indexer.js";
import { computeFingerprint } from "../../src/domains/context/fingerprint.js";
import { detectProjectProfile } from "../../src/domains/session/workspace/project-type.js";

const scratchRoots: string[] = [];

function scratchProject(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	scratchRoots.push(root);
	return root;
}

function git(cwd: string, args: ReadonlyArray<string>): string {
	const child = spawnSync("git", [...args], { cwd, encoding: "utf8" });
	if (child.error) throw child.error;
	if (child.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${child.stderr}`);
	return child.stdout.trim();
}

function treeHashForPaths(cwd: string, relPaths: ReadonlyArray<string>): string {
	const hash = createHash("sha256");
	for (const relPath of [...relPaths].sort()) {
		const stat = statSync(join(cwd, relPath));
		hash.update(`${relPath}:${stat.size}:${Math.floor(stat.mtimeMs)}\n`);
	}
	return hash.digest("hex");
}

type DirectoryEntry = Exclude<ReturnType<Dir["readSync"]>, null>;

function systemError(code: string, message = code): NodeJS.ErrnoException {
	return Object.assign(new Error(message), { code });
}

function fakeEntry(name: string, kind: "directory" | "file"): DirectoryEntry {
	return {
		name,
		isDirectory: () => kind === "directory",
		isFile: () => kind === "file",
	} as DirectoryEntry;
}

function fakeUnknownEntry(name: string): DirectoryEntry {
	return {
		name,
		isDirectory: () => false,
		isFile: () => false,
	} as DirectoryEntry;
}

function fakeDirectory(readSync: () => DirectoryEntry | null): Dir {
	return { readSync, closeSync: () => undefined } as unknown as Dir;
}

function expectIncomplete(
	operation: WorkspaceEnumerationOperation,
	path: string,
	causeCode: string,
	action: () => unknown,
): WorkspaceEnumerationIncompleteError {
	let found: WorkspaceEnumerationIncompleteError | undefined;
	throws(action, (error: unknown) => {
		ok(error instanceof WorkspaceEnumerationIncompleteError);
		strictEqual(error instanceof WorkspaceEnumerationLimitError, false);
		strictEqual(error.code, "WORKSPACE_ENUMERATION_INCOMPLETE");
		strictEqual(error.operation, operation);
		strictEqual(error.path, path);
		strictEqual(error.causeCode, causeCode);
		found = error;
		return true;
	});
	ok(found);
	return found;
}

describe("contracts/workspace-files", () => {
	// Nested inside the describe, not at module top level: under
	// --experimental-test-isolation=none every file shares one root test
	// context, so a top-level beforeEach/afterEach runs around every test in
	// every file, not just this one's.
	afterEach(() => {
		for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("keeps Git-visible source files aligned across index, profile, fingerprint, and incremental updates", async () => {
		const cwd = scratchProject("clio-workspace-files-git-");
		git(cwd, ["init"]);
		git(cwd, ["config", "user.email", "clio-test@example.com"]);
		git(cwd, ["config", "user.name", "Clio Test"]);
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "tracked.ts"), "export const tracked = true;\n", "utf8");
		git(cwd, ["add", "src/tracked.ts"]);

		const ignoredDir = "scratch-output-with-arbitrary-name";
		writeFileSync(join(cwd, ".gitignore"), `${ignoredDir}/\nsrc/tracked.ts\ndist/\n`, "utf8");
		writeFileSync(join(cwd, "src", "wip.ts"), "export const wip = true;\n", "utf8");
		mkdirSync(join(cwd, ignoredDir), { recursive: true });
		writeFileSync(join(cwd, ignoredDir, "noise.ts"), "export const noise = true;\n", "utf8");
		mkdirSync(join(cwd, "dist"), { recursive: true });
		writeFileSync(join(cwd, "dist", "tracked.ts"), "export const generated = true;\n", "utf8");
		git(cwd, ["add", "-f", "dist/tracked.ts"]);

		const files = enumerateWorkspaceFiles(cwd);
		deepStrictEqual(files, [...files].sort());
		deepStrictEqual(
			files.filter((path) => path.endsWith(".ts")),
			["src/tracked.ts", "src/wip.ts"],
		);
		deepStrictEqual(
			filterWorkspaceFileCandidates(cwd, [`${ignoredDir}/noise.ts`, "dist/tracked.ts", "src/wip.ts", "src/tracked.ts"]),
			["src/tracked.ts", "src/wip.ts"],
		);

		const codewiki = await buildCodewiki({ cwd, language: "typescript" });
		deepStrictEqual(
			codewiki.files.map((file) => file.path),
			["src/tracked.ts", "src/wip.ts"],
		);
		const profile = detectProjectProfile(cwd);
		strictEqual(profile.sourceFiles, 2);
		strictEqual(profile.languageCounts.typescript, 2);
		strictEqual(
			computeFingerprint(cwd, codewiki).treeHash,
			treeHashForPaths(
				cwd,
				codewiki.files.map((file) => file.path),
			),
		);

		const unchanged = await updateCodewikiPaths(cwd, codewiki, [`${ignoredDir}/noise.ts`]);
		strictEqual(unchanged, codewiki);
	});

	it("falls back to a bounded filesystem walk outside Git and does not follow symlinks", () => {
		const cwd = scratchProject("clio-workspace-files-fallback-");
		const external = scratchProject("clio-workspace-files-external-");
		mkdirSync(join(cwd, "src"), { recursive: true });
		mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
		writeFileSync(join(cwd, "src", "main.py"), "def main():\n    return 0\n", "utf8");
		writeFileSync(join(cwd, "node_modules", "pkg", "ignored.py"), "ignored = True\n", "utf8");
		writeFileSync(join(external, "outside.py"), "outside = True\n", "utf8");
		symlinkSync(join(external, "outside.py"), join(cwd, "src", "linked.py"));

		const files = enumerateWorkspaceFiles(cwd);
		ok(files.includes("src/main.py"));
		strictEqual(
			files.some((path) => path.includes("node_modules")),
			false,
		);
		strictEqual(files.includes("src/linked.py"), false);
		strictEqual(detectProjectProfile(cwd).sourceFiles, 1);
	});

	it("fails a non-Git scan when its root cannot be opened", () => {
		const cwd = scratchProject("clio-workspace-files-missing-root-");
		const missing = join(cwd, "missing");
		const error = expectIncomplete("open-root", ".", "ENOENT", () => enumerateWorkspaceFiles(missing));
		strictEqual(error.message.includes(missing), false, "diagnostics must not expose the absolute workspace path");
	});

	it("fails instead of returning a partial prefix after a directory read error", (t) => {
		const cwd = scratchProject("clio-workspace-files-read-error-");
		const secret = "facility backend detail must stay private";
		t.mock.method(fs, "opendirSync", (() =>
			fakeDirectory(() => {
				throw systemError("EIO", secret);
			})) as typeof fs.opendirSync);

		const error = expectIncomplete("read-directory", ".", "EIO", () => enumerateWorkspaceFiles(cwd));
		strictEqual(error.message.includes(secret), false, "arbitrary filesystem error text must not be retained");
		strictEqual("cause" in error, false, "the raw filesystem error must not escape on the typed error");
	});

	it("fails with a bounded relative path when a discovered child cannot be opened", (t) => {
		const cwd = scratchProject("clio-workspace-files-child-error-");
		const rawName = `${"a".repeat(110)}\n${"b".repeat(110)}`;
		let rootRead = false;
		let openCount = 0;
		t.mock.method(fs, "opendirSync", (() => {
			openCount += 1;
			if (openCount === 1) {
				return fakeDirectory(() => {
					if (rootRead) return null;
					rootRead = true;
					return fakeEntry(rawName, "directory");
				});
			}
			throw systemError("EACCES", "sensitive mount detail");
		}) as unknown as typeof fs.opendirSync);

		let found: WorkspaceEnumerationIncompleteError | undefined;
		throws(
			() => enumerateWorkspaceFiles(cwd),
			(error: unknown) => {
				ok(error instanceof WorkspaceEnumerationIncompleteError);
				strictEqual(error.operation, "open-directory");
				strictEqual(error.causeCode, "EACCES");
				ok(error.path.length <= 200);
				strictEqual(error.path.includes("\n"), false);
				ok(error.path.startsWith("a"));
				ok(error.path.endsWith("b"));
				strictEqual(error.message.includes("sensitive mount detail"), false);
				found = error;
				return true;
			},
		);
		ok(found);
	});

	it("fails when fallback visibility inspection is denied", (t) => {
		const cwd = scratchProject("clio-workspace-files-inspect-error-");
		let read = false;
		t.mock.method(fs, "opendirSync", (() =>
			fakeDirectory(() => {
				if (read) return null;
				read = true;
				return fakeEntry("unknown.ts", "file");
			})) as typeof fs.opendirSync);
		t.mock.method(fs, "lstatSync", (() => {
			throw systemError("EACCES");
		}) as typeof fs.lstatSync);

		expectIncomplete("inspect-entry", "unknown.ts", "EACCES", () => enumerateWorkspaceFiles(cwd));
	});

	it("inspects unknown directory-entry types instead of silently dropping their subtree", (t) => {
		const cwd = scratchProject("clio-workspace-files-unknown-dirent-");
		let rootRead = false;
		let childRead = false;
		t.mock.method(fs, "opendirSync", ((path: Parameters<typeof fs.opendirSync>[0]) => {
			if (String(path) === cwd) {
				return fakeDirectory(() => {
					if (rootRead) return null;
					rootRead = true;
					return fakeUnknownEntry("network-dir");
				});
			}
			return fakeDirectory(() => {
				if (childRead) return null;
				childRead = true;
				return fakeEntry("visible.ts", "file");
			});
		}) as typeof fs.opendirSync);
		t.mock.method(fs, "lstatSync", ((path: Parameters<typeof fs.lstatSync>[0]) => {
			const value = String(path);
			return {
				isDirectory: () => value.endsWith("network-dir"),
				isFile: () => value.endsWith("visible.ts"),
			};
		}) as unknown as typeof fs.lstatSync);

		deepStrictEqual(enumerateWorkspaceFiles(cwd), ["network-dir/visible.ts"]);
	});

	it("omits entries that disappear during validation but rejects file-to-directory races", (t) => {
		const cwd = scratchProject("clio-workspace-files-races-");
		const entries = [fakeEntry("gone.ts", "file"), fakeEntry("former-parent.ts", "file")];
		t.mock.method(fs, "opendirSync", (() => fakeDirectory(() => entries.shift() ?? null)) as typeof fs.opendirSync);
		t.mock.method(fs, "lstatSync", ((path: Parameters<typeof fs.lstatSync>[0]) => {
			throw systemError(String(path).endsWith("gone.ts") ? "ENOENT" : "ENOTDIR");
		}) as typeof fs.lstatSync);

		deepStrictEqual(enumerateWorkspaceFiles(cwd), []);

		t.mock.restoreAll();
		let read = false;
		t.mock.method(fs, "opendirSync", (() =>
			fakeDirectory(() => {
				if (read) return null;
				read = true;
				return fakeEntry("changed.ts", "file");
			})) as typeof fs.opendirSync);
		t.mock.method(fs, "lstatSync", (() => ({
			isFile: () => false,
			isDirectory: () => true,
		})) as unknown as typeof fs.lstatSync);

		expectIncomplete("inspect-entry", "changed.ts", "ENTRY_TYPE_CHANGED", () => enumerateWorkspaceFiles(cwd));
	});

	it("fails non-Git enumeration explicitly at every resource boundary", () => {
		const cwd = scratchProject("clio-workspace-files-limits-");
		mkdirSync(join(cwd, "deep"), { recursive: true });
		writeFileSync(join(cwd, "root.ts"), "export const root = true;\n", "utf8");
		writeFileSync(join(cwd, "deep", "child.ts"), "export const child = true;\n", "utf8");

		const expectLimit = (kind: WorkspaceEnumerationLimitError["kind"], action: () => unknown): void => {
			throws(action, (error: unknown) => {
				ok(error instanceof WorkspaceEnumerationLimitError);
				strictEqual(error.code, "WORKSPACE_ENUMERATION_LIMIT");
				strictEqual(error.kind, kind);
				return true;
			});
		};

		expectLimit("entries", () => enumerateWorkspaceFiles(cwd, undefined, { maxVisitedEntries: 0 }));
		expectLimit("depth", () => enumerateWorkspaceFiles(cwd, undefined, { maxDepth: 1 }));
		expectLimit("path-bytes", () => enumerateWorkspaceFiles(cwd, undefined, { maxPathBytes: 0 }));
		expectLimit("time", () => enumerateWorkspaceFiles(cwd, undefined, { maxDurationMs: 0 }));
	});

	it("does not let non-Git incremental candidates bypass fallback limits", () => {
		const cwd = scratchProject("clio-workspace-files-incremental-limits-");
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "main.ts"), "export const main = true;\n", "utf8");

		throws(
			() => filterWorkspaceFileCandidates(cwd, ["src/main.ts"], undefined, { maxVisitedEntries: 0 }),
			(error: unknown) => {
				ok(error instanceof WorkspaceEnumerationLimitError);
				strictEqual(error.kind, "entries");
				return true;
			},
		);
	});

	it("reconciles indexed paths when Git ignore visibility changes", async () => {
		const cwd = scratchProject("clio-workspace-files-ignore-transition-");
		git(cwd, ["init"]);
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "wip.ts"), "export const wip = true;\n", "utf8");

		const initial = await buildCodewiki({ cwd, language: "typescript" });
		deepStrictEqual(
			initial.files.map((file) => file.path),
			["src/wip.ts"],
		);

		writeFileSync(join(cwd, ".gitignore"), "src/wip.ts\n", "utf8");
		const ignored = await updateCodewikiPaths(cwd, initial, [".gitignore"]);
		deepStrictEqual(
			ignored.files.map((file) => file.path),
			[],
		);

		writeFileSync(join(cwd, ".gitignore"), "", "utf8");
		const restored = await updateCodewikiPaths(cwd, ignored, [".gitignore"]);
		deepStrictEqual(
			restored.files.map((file) => file.path),
			["src/wip.ts"],
		);
	});

	it("async enumeration returns the same file set as the sync form, on both the Git and fallback paths", async () => {
		const gitCwd = scratchProject("clio-workspace-files-async-git-");
		git(gitCwd, ["init"]);
		mkdirSync(join(gitCwd, "src"), { recursive: true });
		writeFileSync(join(gitCwd, "src", "a.ts"), "export const a = 1;\n", "utf8");
		writeFileSync(join(gitCwd, "untracked.md"), "# wip\n", "utf8");
		git(gitCwd, ["add", "src/a.ts"]);
		deepStrictEqual(await enumerateWorkspaceFilesAsync(gitCwd), enumerateWorkspaceFiles(gitCwd));

		const bareCwd = scratchProject("clio-workspace-files-async-bare-");
		const external = scratchProject("clio-workspace-files-async-ext-");
		mkdirSync(join(bareCwd, "src"), { recursive: true });
		mkdirSync(join(bareCwd, "node_modules", "pkg"), { recursive: true });
		writeFileSync(join(bareCwd, "src", "main.py"), "def main():\n    return 0\n", "utf8");
		writeFileSync(join(bareCwd, "node_modules", "pkg", "ignored.py"), "ignored = True\n", "utf8");
		writeFileSync(join(external, "outside.py"), "outside = True\n", "utf8");
		symlinkSync(join(external, "outside.py"), join(bareCwd, "src", "linked.py"));
		const asyncFiles = await enumerateWorkspaceFilesAsync(bareCwd);
		deepStrictEqual(asyncFiles, enumerateWorkspaceFiles(bareCwd));
		strictEqual(asyncFiles.includes("src/linked.py"), false, "the async walk must not follow symlinks either");
	});

	it("async enumeration keeps the bounded-walk contract and yields through the cooperate hook", async () => {
		const cwd = scratchProject("clio-workspace-files-async-limits-");
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "main.ts"), "export const main = true;\n", "utf8");

		await rejects(enumerateWorkspaceFilesAsync(cwd, undefined, { maxVisitedEntries: 0 }), (error: unknown) => {
			ok(error instanceof WorkspaceEnumerationLimitError);
			strictEqual(error.kind, "entries");
			return true;
		});
		await rejects(enumerateWorkspaceFilesAsync(cwd, undefined, { maxDepth: 1 }), (error: unknown) => {
			ok(error instanceof WorkspaceEnumerationLimitError);
			strictEqual(error.kind, "depth");
			return true;
		});

		let ticks = 0;
		const files = await enumerateWorkspaceFilesAsync(cwd, undefined, undefined, {
			tick: async () => {
				ticks += 1;
			},
		});
		deepStrictEqual(files, enumerateWorkspaceFiles(cwd));
		ok(ticks > 0, "the walk must offer the cooperate hook at least one yield opportunity");
	});
});
