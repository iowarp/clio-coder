import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	evaluateClioCompatibility,
	isValidSemVerRange,
	satisfiesSemVerRange,
} from "../../src/domains/extensions/compatibility.js";
import { loadManifestFromRoot, parseExtensionManifest } from "../../src/domains/extensions/discovery.js";
import {
	enabledExtensionResourceRoots,
	enableExtension,
	installExtension,
	listInstalledExtensions,
} from "../../src/domains/extensions/index.js";
import { getVersionInfo } from "../../src/domains/lifecycle/version.js";

const roots: string[] = [];

function scratch(name: string): string {
	const root = mkdtempSync(path.join(tmpdir(), `clio-extension-${name}-`));
	roots.push(root);
	return root;
}

function manifest(id: string, range: string, resources = "resources: {}\n"): string {
	return [
		"manifestVersion: 1",
		`id: ${id}`,
		`name: ${id}`,
		"version: 1.0.0",
		"description: Compatibility contract fixture.",
		resources.trimEnd(),
		"compatibility:",
		`  clio: "${range}"`,
		"",
	].join("\n");
}

function writeManifest(root: string, id: string, range: string, resources?: string): void {
	mkdirSync(root, { recursive: true });
	writeFileSync(path.join(root, "clio-coder-extension.yaml"), manifest(id, range, resources), "utf8");
}

describe("contracts/extension Clio compatibility", () => {
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("evaluates the ordinary semver range vocabulary and rejects malformed ranges", () => {
		for (const range of [
			">=0.3.8",
			">=0.3.7 <0.4.0",
			"^0.3.7",
			"~0.3.8",
			"0.3.x",
			"0.3.7 - 0.3.9",
			">=1.0.0 || >=0.3.8",
		]) {
			strictEqual(satisfiesSemVerRange("0.3.8", range), true, range);
		}
		for (const range of ["^0.4.0", "~0.3.9", "<0.3.8", ">0.3.8", "0.3.7"]) {
			strictEqual(satisfiesSemVerRange("0.3.8", range), false, range);
		}
		for (const malformed of ["", "latest", ">= nope", "1.x.3", ">=0.3.8 ||", "0.3.08"]) {
			strictEqual(isValidSemVerRange(malformed), false, malformed);
		}
	});

	it("parses a satisfiable range and refuses malformed manifest ranges", () => {
		const running = getVersionInfo().clio;
		const accepted = parseExtensionManifest(
			{
				manifestVersion: 1,
				id: "compatible",
				name: "Compatible",
				version: "1.0.0",
				description: "Compatible extension.",
				resources: {},
				compatibility: { clio: ">=0.0.0" },
			},
			"/fixture/clio-coder-extension.yaml",
		);
		deepStrictEqual(accepted.diagnostics, []);
		strictEqual(accepted.manifest?.compatibility?.clio, ">=0.0.0");
		strictEqual(evaluateClioCompatibility(">=0.0.0").runningVersion, running);

		for (const clio of ["not-a-range", 42, ""]) {
			const refused = parseExtensionManifest(
				{
					manifestVersion: 1,
					id: "malformed",
					name: "Malformed",
					version: "1.0.0",
					description: "Malformed compatibility fixture.",
					resources: {},
					compatibility: { clio },
				},
				"/fixture/clio-coder-extension.yaml",
			);
			strictEqual(refused.manifest, undefined);
			ok(refused.diagnostics.some((diagnostic) => diagnostic.message.includes("compatibility.clio")));
		}
	});

	it("refuses an incompatible install before creating an extension root", () => {
		const project = scratch("install-project");
		const source = scratch("install-source");
		writeManifest(source, "future-only", ">999999.0.0");

		const result = installExtension(source, { cwd: project, scope: "project" });

		strictEqual(result.extension, undefined);
		strictEqual(result.diagnostics.length, 1);
		const message = result.diagnostics[0]?.message ?? "";
		match(message, /extension future-only requires Clio '>999999\.0\.0'/u);
		match(message, new RegExp(`running Clio version is '${getVersionInfo().clio.replaceAll(".", "\\.")}'`, "u"));
		strictEqual(existsSync(path.join(project, ".clio-coder")), false);
	});

	it("installs a satisfiable range silently", () => {
		const project = scratch("satisfied-project");
		const source = scratch("satisfied-source");
		writeManifest(source, "current-clio", ">=0.0.0");

		const result = installExtension(source, { cwd: project, scope: "project" });

		ok(result.extension);
		deepStrictEqual(result.diagnostics, []);
		strictEqual(result.extension.compatible, true);
		strictEqual(result.extension.effective, true);
	});

	it("refuses an incompatible package at load while keeping its diagnostic visible", () => {
		const project = scratch("load-project");
		const installedRoot = path.join(project, ".clio-coder", "extensions", "future-load");
		writeManifest(installedRoot, "future-load", ">999999.0.0", "resources:\n  agents: agents\n");
		mkdirSync(path.join(installedRoot, "agents"), { recursive: true });
		writeFileSync(path.join(installedRoot, "agents", "future.md"), "# unavailable\n", "utf8");

		const candidate = loadManifestFromRoot(installedRoot);
		strictEqual(candidate.valid, false);
		ok(candidate.manifest, "a syntactically valid incompatible manifest remains diagnosable");
		const loaded = listInstalledExtensions(project);
		strictEqual(loaded.length, 1);
		strictEqual(loaded[0]?.compatible, false);
		strictEqual(loaded[0]?.effective, false);
		match(loaded[0]?.diagnostics[0]?.message ?? "", /future-load.*>999999\.0\.0.*running Clio version/u);
		deepStrictEqual(enabledExtensionResourceRoots("agents", project), []);
	});

	it("selects the effective package only from valid and compatible candidates", () => {
		const project = scratch("valid-winner-project");
		const userSource = scratch("valid-winner-user");
		const projectSource = scratch("valid-winner-project-source");
		const outside = scratch("valid-winner-outside");
		writeManifest(userSource, "winner-contract", ">=0.0.0", "resources:\n  agents: agents\n");
		mkdirSync(path.join(userSource, "agents"));
		writeFileSync(path.join(userSource, "agents", "stable.md"), "# stable\n", "utf8");
		ok(installExtension(userSource, { cwd: project, scope: "user" }).extension);

		writeManifest(projectSource, "winner-contract", ">=0.0.0", "resources:\n  agents: agents\n");
		mkdirSync(path.join(projectSource, "agents"));
		ok(installExtension(projectSource, { cwd: project, scope: "project" }).extension);
		const projectRoot = path.join(project, ".clio-coder", "extensions", "winner-contract");
		rmSync(path.join(projectRoot, "agents"), { recursive: true });
		mkdirSync(path.join(outside, "agents"));
		symlinkSync(path.join(outside, "agents"), path.join(projectRoot, "agents"), "dir");

		const loaded = listInstalledExtensions(project);
		strictEqual(loaded.length, 2, "the invalid higher-precedence package remains visible");
		const user = loaded.find((entry) => entry.scope === "user");
		const projectEntry = loaded.find((entry) => entry.scope === "project");
		strictEqual(user?.valid, true);
		strictEqual(user?.effective, true);
		strictEqual(user?.loadable, true);
		strictEqual(projectEntry?.valid, false);
		strictEqual(projectEntry?.effective, false);
		strictEqual(projectEntry?.loadable, false);
		ok(projectEntry?.diagnostics.some((diagnostic) => diagnostic.message.includes("symbolic link")));
		deepStrictEqual(
			enabledExtensionResourceRoots("agents", project).map((root) => root.scope),
			["user"],
		);

		const enabled = enableExtension("winner-contract", { cwd: project, scope: "project" });
		strictEqual(enabled.extension?.enabled, true);
		strictEqual(enabled.extension?.loadable, false, "enabling cannot override package admission");
	});
});
