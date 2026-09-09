import { deepStrictEqual, notStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { evaluateClioCompatibility } from "../../src/domains/extensions/compatibility.js";
import {
	discoverExtensionPackages,
	loadManifestFromRoot,
	parseExtensionManifest,
} from "../../src/domains/extensions/discovery.js";
import { extensionContentDigest, extensionContentDigestWithCapture } from "../../src/domains/extensions/integrity.js";
import {
	installExtension,
	listInstalledExtensionRecords,
	listInstalledExtensions,
	removeExtension,
} from "../../src/domains/extensions/state.js";
import { expandPromptTemplateInput, loadPromptTemplates } from "../../src/domains/resources/prompts/loader.js";
import { createShareArchive, importShareArchive, planShareImport } from "../../src/domains/share/archive.js";

const roots: string[] = [];

function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-extension-resources-"));
	roots.push(root);
	return root;
}

function writeManifest(root: string, id: string, extra = ""): void {
	mkdirSync(root, { recursive: true });
	writeFileSync(
		join(root, "clio-coder-extension.yaml"),
		[
			`id: ${id}`,
			`name: ${id}`,
			"version: 1.0.0",
			"description: Extension integrity fixture.",
			...(extra ? [extra.trimEnd()] : []),
			"",
		].join("\n"),
	);
}

describe("harness extension package boundary", () => {
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("refuses a domain resource declaration and names the plugin installer", () => {
		const base = {
			id: "lab-pack",
			name: "Lab Pack",
			version: "1.0.0",
			description: "Domain workflow that belongs in a plugin.",
		};
		for (const key of ["resources", "prompts", "skills", "agents", "fleets", "themes"] as const) {
			const parsed = parseExtensionManifest({ ...base, [key]: "prompts" }, "/fixture/clio-coder-extension.yaml");
			strictEqual(parsed.manifest, undefined);
			ok(
				parsed.diagnostics.some(
					(diagnostic) =>
						diagnostic.type === "error" &&
						diagnostic.message ===
							`harness extensions cannot declare '${key}'; domain resources belong in a plugin: clio-coder plugins install <path>`,
				),
				`missing plugin guidance for ${key}`,
			);
		}
	});

	it("accepts a strict compatible manifest with no capabilities", () => {
		const parsed = parseExtensionManifest(
			{
				id: "research-kit",
				name: "Research Kit",
				version: "2.0.0",
				description: "Hook-only harness package.",
				compatibility: { clio: ">=0.4.0 <0.5.0" },
			},
			"clio-coder-extension.yaml",
		);
		deepStrictEqual(parsed.diagnostics, []);
		deepStrictEqual(parsed.manifest, {
			id: "research-kit",
			name: "Research Kit",
			version: "2.0.0",
			description: "Hook-only harness package.",
			compatibility: { clio: ">=0.4.0 <0.5.0" },
		});
		deepStrictEqual(evaluateClioCompatibility(">=0.4.0 <0.5.0", "0.4.1"), {
			rangeValid: true,
			satisfied: true,
			runningVersion: "0.4.1",
		});
	});

	it("rejects unknown manifest and compatibility keys", () => {
		const base = {
			id: "strict-keys",
			name: "Strict Keys",
			version: "1.0.0",
			description: "Strict key fixture.",
		};
		for (const [value, expected] of [
			[{ ...base, executable: "index.ts" }, "unknown manifest key 'executable'"],
			[{ ...base, tools: ["read"] }, "unknown manifest key 'tools'"],
			[{ ...base, settings: ["theme"] }, "unknown manifest key 'settings'"],
			[{ ...base, compatibility: { clio: ">=0.0.0", runtime: "node" } }, "unknown compatibility key 'runtime'"],
		] as const) {
			const parsed = parseExtensionManifest(value, "/fixture/clio-coder-extension.yaml");
			strictEqual(parsed.manifest, undefined);
			ok(parsed.diagnostics.some((diagnostic) => diagnostic.message === expected));
		}
	});

	it("canonicalizes duplicate root spellings and retains a deterministic diagnostic", () => {
		const parent = scratch();
		const packageRoot = join(parent, "z-package");
		writeManifest(packageRoot, "canonical-root");
		symlinkSync(packageRoot, join(parent, "a-alias"), "dir");
		symlinkSync(packageRoot, join(parent, "b-alias"), "dir");

		const first = discoverExtensionPackages(parent);
		const second = discoverExtensionPackages(parent);
		deepStrictEqual(second, first);
		strictEqual(first.length, 1);
		strictEqual(first[0]?.path, realpathSync(packageRoot));
		strictEqual(first[0]?.valid, true);
		ok(
			first[0]?.diagnostics.some(
				(diagnostic) =>
					diagnostic.type === "warning" && diagnostic.message.includes("duplicate canonical extension root loaded once"),
			),
		);
	});

	it("retains deterministic diagnostics for roots that cannot be canonicalized", () => {
		const parent = scratch();
		const brokenAlias = join(parent, "broken-alias");
		symlinkSync(join(parent, "missing-package"), brokenAlias, "dir");

		const first = discoverExtensionPackages(parent);
		const second = discoverExtensionPackages(parent);

		deepStrictEqual(second, first);
		strictEqual(first.length, 1);
		strictEqual(first[0]?.path, brokenAlias);
		strictEqual(first[0]?.valid, false);
		ok(first[0]?.diagnostics.some((diagnostic) => diagnostic.message.includes("could not be canonicalized")));
	});

	it("still rejects the same id from distinct canonical roots", () => {
		const parent = scratch();
		writeManifest(join(parent, "one"), "duplicate-id");
		writeManifest(join(parent, "two"), "duplicate-id");
		const discovered = discoverExtensionPackages(parent);
		strictEqual(discovered.length, 2);
		ok(discovered.every((candidate) => !candidate.valid));
		ok(
			discovered.every((candidate) =>
				candidate.diagnostics.some((diagnostic) => diagnostic.message === "duplicate extension id duplicate-id"),
			),
		);
	});

	it("rejects hard-linked files from content identity and deactivates the package", () => {
		const project = scratch();
		const source = scratch();
		const outside = scratch();
		writeManifest(source, "hardlink-package");
		strictEqual(installExtension(source, { cwd: project, scope: "project" }).extension?.loadable, true);

		const installedRoot = join(project, ".clio-coder", "extensions", "hardlink-package");
		writeFileSync(join(outside, "shared.md"), "shared bytes\n");
		linkSync(join(outside, "shared.md"), join(installedRoot, "shared.md"));
		throws(() => extensionContentDigest(installedRoot), /hard-linked file/u);

		const [entry] = listInstalledExtensions(project, { scope: "project" });
		strictEqual(entry?.loadable, false);
		ok(entry?.diagnostics.some((diagnostic) => diagnostic.message.includes("hard-linked file")));
	});

	it("frames file names, payloads, and symbolic-link targets without ambiguity", () => {
		const first = scratch();
		const second = scratch();
		writeManifest(first, "framing-proof");
		writeManifest(second, "framing-proof");
		writeFileSync(join(first, "ab"), "c");
		writeFileSync(join(second, "a"), "bc");
		notStrictEqual(extensionContentDigest(first), extensionContentDigest(second));

		rmSync(join(first, "ab"));
		rmSync(join(second, "a"));
		writeFileSync(join(first, "target"), "same target\n");
		writeFileSync(join(second, "target"), "same target\n");
		symlinkSync("target", join(first, "alias"));
		symlinkSync("./target", join(second, "alias"));
		notStrictEqual(extensionContentDigest(first), extensionContentDigest(second));
	});

	it("rejects a symbolic link in place of the package root", () => {
		const actualRoot = scratch();
		const aliasParent = scratch();
		writeManifest(actualRoot, "linked-root");
		const alias = join(aliasParent, "package-alias");
		symlinkSync(actualRoot, alias, "dir");

		throws(() => extensionContentDigest(alias), /extension root must be a directory, not a symbolic link/u);
	});

	it("does not follow a file swapped to a symlink between inspection and read", () => {
		const root = scratch();
		const outside = scratch();
		writeManifest(root, "digest-race");
		const victim = join(root, "payload.txt");
		const parked = join(root, "payload.parked");
		const outsideFile = join(outside, "outside.txt");
		writeFileSync(victim, "installed bytes\n");
		writeFileSync(outsideFile, "outside bytes\n");
		const expected = extensionContentDigest(root);

		const require = createRequire(import.meta.url);
		const fs = require("node:fs") as Record<string, unknown>;
		const originalReadFileSync = fs.readFileSync as typeof readFileSync;
		fs.readFileSync = ((file: Parameters<typeof readFileSync>[0], options?: unknown) => {
			if (file === victim) {
				renameSync(victim, parked);
				symlinkSync(outsideFile, victim);
			}
			return originalReadFileSync(file, options as never);
		}) as typeof readFileSync;
		syncBuiltinESMExports();
		try {
			strictEqual(extensionContentDigest(root), expected);
			strictEqual(lstatSync(victim).isFile(), true);
		} finally {
			fs.readFileSync = originalReadFileSync;
			syncBuiltinESMExports();
			if (lstatSync(victim, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(victim);
			if (lstatSync(parked, { throwIfNoEntry: false })?.isFile()) renameSync(parked, victim);
		}
	});

	it("rejects a symbolic link swapped outside the package while being hashed", () => {
		const root = scratch();
		const outside = scratch();
		writeManifest(root, "symlink-race");
		const internalTarget = join(root, "internal.txt");
		const outsideTarget = join(outside, "outside.txt");
		const link = join(root, "alias.txt");
		writeFileSync(internalTarget, "internal bytes\n");
		writeFileSync(outsideTarget, "outside bytes\n");
		symlinkSync("internal.txt", link);

		const require = createRequire(import.meta.url);
		const fs = require("node:fs") as Record<string, unknown>;
		const originalReadlinkSync = fs.readlinkSync as (path: string) => string;
		fs.readlinkSync = ((file: string) => {
			if (file === link) {
				rmSync(link);
				symlinkSync(outsideTarget, link);
			}
			return originalReadlinkSync(file);
		}) as typeof originalReadlinkSync;
		syncBuiltinESMExports();
		try {
			throws(() => extensionContentDigest(root), /symbolic link (?:changed|escapes)/u);
		} finally {
			fs.readlinkSync = originalReadlinkSync;
			syncBuiltinESMExports();
			rmSync(link, { force: true });
			symlinkSync("internal.txt", link);
		}
	});

	it("rejects a directory swapped outside the package while being hashed", () => {
		const root = scratch();
		const outside = scratch();
		writeManifest(root, "directory-race");
		const directory = join(root, "tree");
		const parked = join(root, "tree.parked");
		mkdirSync(directory);
		writeFileSync(join(directory, "inside.txt"), "inside bytes\n");
		writeFileSync(join(outside, "outside.txt"), "outside bytes\n");

		const require = createRequire(import.meta.url);
		const fs = require("node:fs") as Record<string, unknown>;
		const originalReaddirSync = fs.readdirSync as (path: string) => string[];
		fs.readdirSync = ((path: string) => {
			if (path === directory) {
				renameSync(directory, parked);
				symlinkSync(outside, directory, "dir");
			}
			return originalReaddirSync(path);
		}) as typeof originalReaddirSync;
		syncBuiltinESMExports();
		try {
			throws(() => extensionContentDigest(root), /extension directory (?:changed|escapes)/u);
		} finally {
			fs.readdirSync = originalReaddirSync;
			syncBuiltinESMExports();
			rmSync(directory, { recursive: true, force: true });
			renameSync(parked, directory);
		}
	});

	it("rejects special filesystem entries from the package tree", { skip: process.platform === "win32" }, () => {
		const project = scratch();
		const source = scratch();
		writeManifest(source, "special-entry");
		strictEqual(installExtension(source, { cwd: project, scope: "project" }).extension?.loadable, true);

		const installedRoot = join(project, ".clio-coder", "extensions", "special-entry");
		const fifoPath = join(installedRoot, "resource.fifo");
		const created = spawnSync("mkfifo", [fifoPath]);
		strictEqual(created.status, 0, created.error?.message);
		strictEqual(lstatSync(fifoPath).isFIFO(), true);
		throws(() => extensionContentDigest(installedRoot), /unsupported filesystem entry/u);

		const [entry] = listInstalledExtensions(project, { scope: "project" });
		strictEqual(entry?.loadable, false);
		ok(entry?.diagnostics.some((diagnostic) => diagnostic.message.includes("unsupported filesystem entry")));
	});

	it("keeps a package whose tree escapes its root visible but inactive", () => {
		const project = scratch();
		const source = scratch();
		const outside = scratch();
		writeManifest(source, "escaping-tree");
		strictEqual(installExtension(source, { cwd: project, scope: "project" }).extension?.loadable, true);

		const installedRoot = join(project, ".clio-coder", "extensions", "escaping-tree");
		mkdirSync(join(outside, "payload"));
		symlinkSync(join(outside, "payload"), join(installedRoot, "payload"), "dir");
		throws(() => extensionContentDigest(installedRoot), /symbolic link escapes the extension root/u);

		strictEqual(loadManifestFromRoot(installedRoot).valid, true, "the manifest itself is well formed");
		const [entry] = listInstalledExtensions(project);
		strictEqual(entry?.valid, false);
		strictEqual(entry?.effective, false);
		strictEqual(entry?.loadable, false);
		strictEqual(entry?.provenance, undefined, "an escaping tree never earns provenance");
		ok(
			entry?.diagnostics.some(
				(diagnostic) =>
					diagnostic.type === "error" &&
					diagnostic.message.includes("could not be verified") &&
					diagnostic.message.includes("symbolic link escapes the extension root"),
			),
			JSON.stringify(entry?.diagnostics),
		);
	});

	it("revalidates the staged copy and preserves the previous install on failure", () => {
		const project = scratch();
		const original = scratch();
		const replacement = scratch();
		writeManifest(original, "staged-rollback");
		writeFileSync(join(original, "marker.txt"), "original\n");
		const first = installExtension(original, { cwd: project, scope: "project" });
		ok(first.extension?.loadable);
		const originalDigest = first.extension.provenance?.contentDigest;

		writeManifest(replacement, "staged-rollback");
		mkdirSync(join(replacement, "real-payload"));
		writeFileSync(join(replacement, "real-payload", "replacement.md"), "# replacement\n");
		// Valid at the source location, but copying preserves this absolute link.
		// At staging it points outside the staged package and must be rejected.
		symlinkSync(join(replacement, "real-payload"), join(replacement, "payload"), "dir");
		strictEqual(loadManifestFromRoot(replacement).valid, true);
		ok(extensionContentDigest(replacement).length > 0, "the link is contained at its source location");

		const forced = installExtension(replacement, { cwd: project, scope: "project", force: true });
		strictEqual(forced.extension, undefined);
		ok(forced.diagnostics.some((diagnostic) => diagnostic.message.includes("escapes the extension root")));
		const installedRoot = join(project, ".clio-coder", "extensions", "staged-rollback");
		strictEqual(readFileSync(join(installedRoot, "marker.txt"), "utf8"), "original\n");
		const [preserved] = listInstalledExtensions(project, { scope: "project" });
		strictEqual(preserved?.loadable, true);
		strictEqual(preserved?.provenance?.contentDigest, originalDigest);
		strictEqual(preserved?.observedContentDigest, originalDigest);
	});

	it("restores the previous package when the install-state commit fails", () => {
		const project = scratch();
		const original = scratch();
		const replacement = scratch();
		writeManifest(original, "state-rollback");
		writeFileSync(join(original, "marker.txt"), "original\n");
		const first = installExtension(original, { cwd: project, scope: "project" });
		strictEqual(first.extension?.loadable, true);
		const originalDigest = first.extension?.provenance?.contentDigest;

		writeManifest(replacement, "state-rollback");
		writeFileSync(join(replacement, "marker.txt"), "replacement\n");
		const statePath = join(project, ".clio-coder", "extensions", "state.json");
		const require = createRequire(import.meta.url);
		const fs = require("node:fs") as Record<string, unknown>;
		const originalRenameSync = fs.renameSync as typeof renameSync;
		fs.renameSync = ((from: Parameters<typeof renameSync>[0], to: Parameters<typeof renameSync>[1]) => {
			if (to === statePath) throw new Error("injected state commit failure");
			return originalRenameSync(from, to);
		}) as typeof renameSync;
		syncBuiltinESMExports();
		let forced: ReturnType<typeof installExtension>;
		try {
			forced = installExtension(replacement, { cwd: project, scope: "project", force: true });
		} finally {
			fs.renameSync = originalRenameSync;
			syncBuiltinESMExports();
		}

		strictEqual(forced.extension, undefined);
		ok(forced.diagnostics.some((diagnostic) => diagnostic.message.includes("injected state commit failure")));
		const installedRoot = join(project, ".clio-coder", "extensions", "state-rollback");
		strictEqual(readFileSync(join(installedRoot, "marker.txt"), "utf8"), "original\n");
		const [preserved] = listInstalledExtensions(project, { scope: "project" });
		strictEqual(preserved?.loadable, true);
		strictEqual(preserved?.provenance?.contentDigest, originalDigest);
	});

	it("detects post-install content drift and prevents activation", () => {
		const project = scratch();
		const source = scratch();
		writeManifest(source, "drift-contract");
		writeFileSync(join(source, "hooks.yaml"), "[]\n");
		const result = installExtension(source, { cwd: project, scope: "project" });
		ok(result.extension?.loadable);
		const installedRoot = join(project, ".clio-coder", "extensions", "drift-contract");
		writeFileSync(join(installedRoot, "hooks.yaml"), "# changed after install\n[]\n");

		const [drifted] = listInstalledExtensions(project, { scope: "project" });
		strictEqual(drifted?.valid, false);
		strictEqual(drifted?.effective, false);
		strictEqual(drifted?.loadable, false);
		strictEqual(drifted?.provenance, undefined);
		ok(result.extension?.provenance?.contentDigest);
		ok(drifted?.observedContentDigest);
		ok(result.extension?.provenance?.contentDigest !== drifted?.observedContentDigest);
		ok(drifted?.diagnostics.some((diagnostic) => diagnostic.message.includes("content drift detected")));
	});

	it("captures manifest and hook bytes from the stable digest read and builds structured provenance", () => {
		const project = scratch();
		const source = scratch();
		writeManifest(source, "captured-provenance");
		const hookBytes = Buffer.from("- id: captured\n  on: turn_start\n  kind: prompt\n  message: captured bytes\n");
		writeFileSync(join(source, "hooks.yaml"), hookBytes);
		const direct = extensionContentDigestWithCapture(source, {
			capture: ["clio-coder-extension.yaml", "hooks.yaml", "absent.txt"],
		});
		strictEqual(direct.digest, extensionContentDigest(source));
		deepStrictEqual(direct.captured.get("hooks.yaml"), hookBytes);
		strictEqual(direct.captured.has("absent.txt"), false);

		const installed = installExtension(source, { cwd: project, scope: "project" }).extension;
		ok(installed?.loadable);
		const [record] = listInstalledExtensionRecords(project, { scope: "project", all: true });
		ok(record?.entry.provenance);
		strictEqual(record.entry.provenance.id, "captured-provenance");
		strictEqual(record.entry.provenance.scope, "project");
		strictEqual(record.entry.provenance.sourcePath, source);
		strictEqual(record.entry.provenance.canonicalRoot, realpathSync(record.entry.rootPath));
		strictEqual(record.entry.provenance.contentDigest, record.entry.observedContentDigest);
		strictEqual(
			record.entry.provenance.manifestDigest,
			createHash("sha256")
				.update(record.captured?.get("clio-coder-extension.yaml") ?? "")
				.digest("hex"),
		);
		deepStrictEqual(record.captured?.get("hooks.yaml"), hookBytes);
	});

	it("distinguishes absent install state from corrupt install state and fails closed", () => {
		const absentProject = scratch();
		const absentRoot = join(absentProject, ".clio-coder", "extensions", "absent-state");
		writeManifest(absentRoot, "absent-state");
		const [absent] = listInstalledExtensions(absentProject, { scope: "project" });
		strictEqual(absent?.loadable, false);
		ok(absent?.diagnostics.some((diagnostic) => diagnostic.message.includes("install state is absent")));

		const corruptProject = scratch();
		const corruptBase = join(corruptProject, ".clio-coder", "extensions");
		writeManifest(join(corruptBase, "corrupt-state"), "corrupt-state");
		writeFileSync(join(corruptBase, "state.json"), "{ not-json\n");
		const [corrupt] = listInstalledExtensions(corruptProject, { scope: "project" });
		strictEqual(corrupt?.loadable, false);
		ok(corrupt?.diagnostics.some((diagnostic) => diagnostic.message.includes("install state is corrupt")));
	});

	it("backs up corrupt state and unverifiable bytes during remove and forced reinstall recovery", () => {
		const removeProject = scratch();
		const removeBase = join(removeProject, ".clio-coder", "extensions");
		const removeRoot = join(removeBase, "corrupt-remove");
		writeManifest(removeRoot, "corrupt-remove");
		writeFileSync(join(removeRoot, "marker.txt"), "preserve remove bytes\n", "utf8");
		const corruptState = "{ definitely-not-json\n";
		writeFileSync(join(removeBase, "state.json"), corruptState, "utf8");
		listInstalledExtensions(removeProject, { scope: "project" });
		strictEqual(readFileSync(join(removeBase, "state.json"), "utf8"), corruptState, "inspection stays read-only");

		const removed = removeExtension("corrupt-remove", { cwd: removeProject, scope: "project" });
		strictEqual(removed.removed?.id, "corrupt-remove");
		ok(removed.recovery?.stateBackup);
		ok(removed.recovery?.packageBackup);
		strictEqual(readFileSync(removed.recovery?.stateBackup as string, "utf8"), corruptState);
		strictEqual(
			readFileSync(join(removed.recovery?.packageBackup as string, "marker.txt"), "utf8"),
			"preserve remove bytes\n",
		);
		strictEqual(existsSync(removeRoot), false);
		deepStrictEqual(listInstalledExtensions(removeProject, { scope: "project" }), []);

		const reinstallProject = scratch();
		const reinstallBase = join(reinstallProject, ".clio-coder", "extensions");
		const oldRoot = join(reinstallBase, "corrupt-reinstall");
		writeManifest(oldRoot, "corrupt-reinstall");
		writeFileSync(join(oldRoot, "marker.txt"), "old unverifiable bytes\n", "utf8");
		writeFileSync(join(reinstallBase, "state.json"), corruptState, "utf8");
		const replacement = scratch();
		writeManifest(replacement, "corrupt-reinstall");
		writeFileSync(join(replacement, "marker.txt"), "verified replacement\n", "utf8");

		const refused = installExtension(replacement, { cwd: reinstallProject, scope: "project" });
		strictEqual(refused.extension, undefined);
		ok(refused.diagnostics.some((diagnostic) => diagnostic.message.includes("retry with --force")));
		const reinstalled = installExtension(replacement, { cwd: reinstallProject, scope: "project", force: true });
		strictEqual(reinstalled.extension?.loadable, true);
		ok(reinstalled.recovery?.stateBackup);
		ok(reinstalled.recovery?.packageBackup);
		strictEqual(readFileSync(reinstalled.recovery?.stateBackup as string, "utf8"), corruptState);
		strictEqual(
			readFileSync(join(reinstalled.recovery?.packageBackup as string, "marker.txt"), "utf8"),
			"old unverifiable bytes\n",
		);
		strictEqual(readFileSync(join(oldRoot, "marker.txt"), "utf8"), "verified replacement\n");
	});

	it("routes share-imported extension trees through verified installation", () => {
		const exporter = scratch();
		const source = scratch();
		writeManifest(source, "shared-extension");
		writeFileSync(join(source, "hooks.yaml"), "[]\n", "utf8");
		const exportedInstall = installExtension(source, { cwd: exporter, scope: "project" });
		strictEqual(exportedInstall.extension?.loadable, true);
		const archive = createShareArchive({ cwd: exporter, scope: "project", includeExtensions: true });
		ok(archive.files.every((file) => file.type === "extension"));
		ok(archive.files.every((file) => !file.relativePath.endsWith("state.json")));
		const archivePath = join(scratch(), "extensions.clio-coder-share.json");
		writeFileSync(archivePath, `${JSON.stringify(archive)}\n`, "utf8");

		const destination = scratch();
		const destinationBase = join(destination, ".clio-coder", "extensions");
		const dryRun = planShareImport(archivePath, { cwd: destination, scope: "project", dryRun: true });
		deepStrictEqual(
			dryRun.diagnostics.filter((diagnostic) => diagnostic.type !== "warning"),
			[],
		);
		strictEqual(existsSync(destinationBase), false, "share inspection must not mutate extension state");

		const imported = importShareArchive(archivePath, { cwd: destination, scope: "project" });
		deepStrictEqual(
			imported.diagnostics.filter((diagnostic) => diagnostic.type !== "warning"),
			[],
		);
		const [installed] = listInstalledExtensions(destination, { scope: "project" });
		strictEqual(installed?.id, "shared-extension");
		strictEqual(installed?.loadable, true);
		ok(installed?.provenance?.contentDigest);
		strictEqual(installed?.observedContentDigest, installed?.provenance?.contentDigest);
	});

	it("refuses invalid shared packages and force-recovers an unverified destination transactionally", () => {
		const invalidExporter = scratch();
		const invalidRoot = join(invalidExporter, ".clio-coder", "extensions", "invalid-shared");
		writeManifest(invalidRoot, "invalid-shared", "resources:\n  prompts: prompts\n");
		const invalidArchive = createShareArchive({
			cwd: invalidExporter,
			scope: "project",
			includeExtensions: true,
		});
		const invalidArchivePath = join(scratch(), "invalid.clio-coder-share.json");
		writeFileSync(invalidArchivePath, `${JSON.stringify(invalidArchive)}\n`, "utf8");
		const invalidDestination = scratch();
		const refused = importShareArchive(invalidArchivePath, { cwd: invalidDestination, scope: "project" });
		ok(refused.diagnostics.some((diagnostic) => diagnostic.message.includes("share archive is invalid")));
		strictEqual(existsSync(join(invalidDestination, ".clio-coder", "extensions")), false);

		const exporter = scratch();
		const source = scratch();
		writeManifest(source, "shared-recovery");
		writeFileSync(join(source, "marker.txt"), "verified archive bytes\n", "utf8");
		strictEqual(installExtension(source, { cwd: exporter, scope: "project" }).extension?.loadable, true);
		const archive = createShareArchive({ cwd: exporter, scope: "project", includeExtensions: true });
		const archivePath = join(scratch(), "recovery.clio-coder-share.json");
		writeFileSync(archivePath, `${JSON.stringify(archive)}\n`, "utf8");

		const destination = scratch();
		const destinationBase = join(destination, ".clio-coder", "extensions");
		const oldRoot = join(destinationBase, "shared-recovery");
		writeManifest(oldRoot, "shared-recovery");
		writeFileSync(join(oldRoot, "marker.txt"), "unverified destination bytes\n", "utf8");
		const corruptState = "{ corrupt-share-state\n";
		writeFileSync(join(destinationBase, "state.json"), corruptState, "utf8");
		const blocked = importShareArchive(archivePath, { cwd: destination, scope: "project" });
		ok(blocked.diagnostics.some((diagnostic) => diagnostic.type === "conflict"));
		strictEqual(readFileSync(join(oldRoot, "marker.txt"), "utf8"), "unverified destination bytes\n");
		strictEqual(readFileSync(join(destinationBase, "state.json"), "utf8"), corruptState);

		const recovered = importShareArchive(archivePath, { cwd: destination, scope: "project", force: true });
		deepStrictEqual(
			recovered.diagnostics.filter((diagnostic) => diagnostic.type === "error" || diagnostic.type === "conflict"),
			[],
		);
		ok(recovered.recovery?.backups.some((backup) => readFileSync(backup, "utf8") === corruptState));
		ok(
			recovered.recovery?.backups.some(
				(backup) =>
					existsSync(join(backup, "marker.txt")) &&
					readFileSync(join(backup, "marker.txt"), "utf8") === "unverified destination bytes\n",
			),
		);
		const [installed] = listInstalledExtensions(destination, { scope: "project" });
		strictEqual(installed?.loadable, true);
		strictEqual(readFileSync(join(oldRoot, "marker.txt"), "utf8"), "verified archive bytes\n");
	});

	it("preserves every payload byte after the command delimiter", () => {
		const promptRoot = scratch();
		mkdirSync(join(promptRoot, "research"));
		writeFileSync(
			join(promptRoot, "research", "draft.md"),
			["<invocation_arguments>", "$ARGUMENTS", "</invocation_arguments>", ""].join("\n"),
		);
		const templates = loadPromptTemplates({
			roots: [{ path: promptRoot, scope: "project", source: "plugin:project:research-kit", trusted: true }],
		});
		const payload = ["", "  Exact  spacing.", "", "\t- Keep tabs.", "Trailing spaces.  ", ""].join("\n");
		const expanded = expandPromptTemplateInput(`/research:draft\n${payload}`, templates);
		strictEqual(expanded.expanded, true);
		if (!expanded.expanded) return;
		strictEqual(expanded.text, ["<invocation_arguments>", payload, "</invocation_arguments>"].join("\n"));
		ok(expanded.template.filePath.endsWith(join("research", "draft.md")));
	});
});
