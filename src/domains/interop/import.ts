/**
 * Explicit library import: one plan/apply/release seam shared by the CLI and a
 * later TUI. A plan retains the fetched source until apply or release; apply
 * re-projects the source, refuses drift, publishes through the library install
 * seam with foreign trust, then reports publication, validation and runtime
 * admission as three separate facts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fetchPluginSource, parsePluginGithubSource, pluginLocalPath } from "../plugins/catalog.js";
import { listInstalledPlugins, pluginBaseDir, readPluginManifest } from "../plugins/index.js";
import type { ForeignPackageFormat, PluginOrigin } from "../plugins/types.js";
import { type LibraryPackageValidationResult, validateLibraryPackage } from "../resources/library-validation.js";
import {
	type PreparedAdoption,
	prepareForeignPackage,
	preparePortablePackage,
	unmetRequirements,
	vendorOf,
} from "./adopt.js";
import { detectForeignPlugin, type ForeignPluginDetection, type ForeignResourceOutcome } from "./foreign.js";
import { installInteropPackage } from "./install.js";
import { digest, reviewFingerprint } from "./projection.js";
import type { InteropAgentId } from "./types.js";

export interface LibraryImportSource {
	input: string;
	transport: "local" | "github";
	/** Directory the plan reads; staged clone for github, the operator's path for local. */
	root: string;
	url?: string;
	path?: string;
}

export interface LibraryImportPlan {
	source: LibraryImportSource;
	detection: ForeignPluginDetection;
	format?: ForeignPackageFormat;
	action: "install" | "blocked";
	/** Why the plan is blocked, or review notes for an installable plan. */
	reasons: string[];
	id?: string;
	version?: string;
	destination?: string;
	digest?: string;
	scope: "user" | "project";
	cwd: string;
	outcomes: ForeignResourceOutcome[];
	unsupported: string[];
	omitted: string[];
	requirements: string[];
	/** Exactly the provenance record apply persists. */
	origin: PluginOrigin;
	/** Full-tree review fingerprint (paths, modes, bytes, hidden manifests, omitted files); apply refuses drift. */
	reviewFingerprint: string;
	/** Reviewed bytes. Never serialized by the CLI. */
	files?: Readonly<Record<string, string>>;
	/** Release retained remote staging. Never serialized. */
	cleanup: () => void;
}

export interface LibraryImportApplyResult {
	/** The package was written to disk and recorded in install state. */
	published: boolean;
	installed?: string;
	destination?: string;
	/** Native validation of the installed recipe files; absent when nothing was published. */
	validation?: LibraryPackageValidationResult;
	/**
	 * Trust admission is a separate fact from publication and validity. This is
	 * only the gate setting the caller supplied; actual recipe availability is
	 * the inventory's fact.
	 */
	admission: {
		trust: "foreign";
		gate: "integrations.projectResources.trustProjectImports";
		gateEnabled: boolean | "unknown";
	};
	diagnostics: string[];
}

function prepare(
	root: string,
	format?: "claude-code" | "codex",
): { detection: ForeignPluginDetection; value: PreparedAdoption } {
	const detection = detectForeignPlugin(root, format);
	if (detection.format === "portable") return { detection, value: preparePortablePackage(root) };
	if (detection.format === "none") throw new Error(detection.diagnostics.join(" "));
	return { detection, value: prepareForeignPackage(root, detection.format) };
}

export function planLibraryImport(
	input: string,
	options: {
		cwd?: string;
		scope?: "user" | "project";
		format?: "claude-code" | "codex";
		/** Set only when the source was discovered inside an installed local agent. */
		host?: InteropAgentId;
		marketplace?: string;
	} = {},
): LibraryImportPlan {
	const cwd = path.resolve(options.cwd ?? process.cwd());
	const scope = options.scope ?? "user";
	const remote = parsePluginGithubSource(input);
	const local = pluginLocalPath(input, cwd);
	const fetched = fetchPluginSource(input, cwd);
	const source: LibraryImportSource = remote
		? { input, transport: "github", root: fetched.root, url: input }
		: { input, transport: "local", root: fetched.root, path: local };
	const originSource = remote ? input : path.resolve(local);
	try {
		const raw = reviewFingerprint(fetched.root);
		let detection: ForeignPluginDetection;
		let value: PreparedAdoption | undefined;
		const reasons: string[] = [];
		try {
			({ detection, value } = prepare(fetched.root, options.format));
		} catch (error) {
			detection = detectForeignPlugin(fetched.root, options.format);
			reasons.push(error instanceof Error ? error.message : String(error));
		}
		reasons.push(...detection.diagnostics);
		const format = value?.format ?? (detection.format === "none" ? undefined : detection.format);
		const origin: PluginOrigin = {
			kind: "import",
			source: originSource,
			transport: remote ? "github" : "local",
			format: format ?? "portable",
			...(options.host ? { host: options.host } : {}),
			...(options.marketplace ? { marketplace: options.marketplace } : {}),
		};
		const base: Omit<LibraryImportPlan, "action" | "reasons"> = {
			source,
			detection,
			...(format ? { format } : {}),
			scope,
			cwd,
			outcomes: value?.outcomes ?? [],
			unsupported: value?.unsupported ?? [],
			omitted: value?.omitted ?? [],
			requirements: value?.requirements ?? [],
			origin,
			reviewFingerprint: raw,
			cleanup: fetched.cleanup,
		};
		if (!value) return { ...base, action: "blocked", reasons };
		const missing = unmetRequirements(value.requirements, cwd, scope, vendorOf(value.format));
		if (missing.length)
			reasons.push(
				`Unsatisfied package requirements: ${missing.join(", ")}. Install or import those packages first; no extra resources are imported.`,
			);
		const installed = listInstalledPlugins(cwd, { all: true });
		if (installed.some((pkg) => pkg.id === value.id && pkg.scope === scope))
			reasons.push(`Package ${value.id} is already installed in ${scope} scope; remove it before importing again.`);
		const blocked = missing.length > 0 || installed.some((pkg) => pkg.id === value.id && pkg.scope === scope);
		return {
			...base,
			action: blocked ? "blocked" : "install",
			reasons: [value.note, ...reasons],
			id: value.id,
			version: value.version,
			destination: path.join(pluginBaseDir(scope, cwd), value.id),
			digest: digest(value.files),
			files: value.files,
		};
	} catch (error) {
		fetched.cleanup();
		throw error;
	}
}

export function releaseLibraryImport(plan: LibraryImportPlan): void {
	plan.cleanup();
}

/** Apply always releases the plan, whether it installs, refuses, or throws. */
export function applyLibraryImport(
	plan: LibraryImportPlan,
	approved: boolean,
	options: { trustProjectImports?: boolean } = {},
): LibraryImportApplyResult {
	const admission = {
		trust: "foreign" as const,
		gate: "integrations.projectResources.trustProjectImports" as const,
		gateEnabled: options.trustProjectImports === undefined ? ("unknown" as const) : options.trustProjectImports,
	};
	const result: LibraryImportApplyResult = { published: false, admission, diagnostics: [] };
	let staging: string | undefined;
	try {
		if (!approved) {
			result.diagnostics.push("Approval required; nothing installed.");
			return result;
		}
		if (plan.action !== "install" || !plan.files || !plan.id || !plan.digest) {
			result.diagnostics.push(...(plan.reasons.length ? plan.reasons : ["Plan is not installable."]));
			return result;
		}
		if (reviewFingerprint(plan.source.root) !== plan.reviewFingerprint)
			throw new Error("Source changed after review; inspect a new plan.");
		const current = prepare(plan.source.root, plan.format === "portable" ? undefined : plan.format).value;
		if (digest(plan.files) !== plan.digest || digest(current.files) !== plan.digest)
			throw new Error("Plan changed after review; inspect a new plan.");
		const missing = unmetRequirements(current.requirements, plan.cwd, plan.scope, vendorOf(current.format));
		if (missing.length)
			throw new Error(
				`Unsatisfied package requirements after review: ${missing.join(", ")}. No extra resources are imported.`,
			);
		staging = mkdtempSync(path.join(tmpdir(), "clio-coder-library-import-"));
		for (const [file, text] of Object.entries(plan.files)) {
			const target = path.join(staging, file);
			mkdirSync(path.dirname(target), { recursive: true });
			writeFileSync(target, text, { mode: 0o644 });
		}
		const candidate = readPluginManifest(staging);
		if (!candidate.valid || !candidate.contentDigest)
			throw new Error(candidate.diagnostics.map((d) => d.message).join("; "));
		const installed = installInteropPackage({
			sourcePath: staging,
			kind: candidate.manifest?.clio.kind ?? "plugin",
			trust: "foreign",
			cwd: plan.cwd,
			scope: plan.scope,
			expectedId: plan.id,
			expectedDigest: candidate.contentDigest,
			origin: plan.origin,
		});
		result.diagnostics.push(...installed.diagnostics.map((d) => d.message));
		if (installed.plugin) {
			result.published = true;
			result.installed = installed.plugin.id;
			result.destination = installed.plugin.rootPath;
			result.validation = validateLibraryPackage(installed.plugin.rootPath, { cwd: plan.cwd });
		}
		return result;
	} catch (error) {
		result.diagnostics.push(error instanceof Error ? error.message : String(error));
		return result;
	} finally {
		if (staging) rmSync(staging, { recursive: true, force: true });
		releaseLibraryImport(plan);
	}
}

/** JSON-safe view: no reviewed bytes, no callbacks. */
export function libraryImportPlanSummary(plan: LibraryImportPlan): Omit<LibraryImportPlan, "files" | "cleanup"> {
	const { files: _files, cleanup: _cleanup, ...summary } = plan;
	return summary;
}

export function renderLibraryImportPlan(plan: LibraryImportPlan): string {
	const lines = [
		`Import ${plan.source.transport === "github" ? plan.source.url : plan.source.path} into Clio (${plan.scope})?`,
		`  Format: ${plan.format ?? "unknown"}${plan.detection.manifestPath ? ` (${plan.detection.manifestPath})` : ""}`,
		...(plan.action === "install"
			? [`  Package: ${plan.id} ${plan.version}`, `  Destination: ${plan.destination}`, `  SHA-256: ${plan.digest}`]
			: ["  BLOCKED"]),
		...plan.reasons.map((reason) => `  ${reason}`),
		...(plan.requirements.length ? [`  Requires installed packages: ${plan.requirements.join(", ")}`] : []),
		...plan.outcomes.map((outcome) => {
			const detail = [
				...(outcome.omittedFields?.length ? [`omitted frontmatter: ${outcome.omittedFields.join(", ")}`] : []),
				...(outcome.omittedFiles?.length ? [`omitted files: ${outcome.omittedFiles.join(", ")}`] : []),
				...(outcome.reason ? [outcome.reason] : []),
			];
			return outcome.status === "converted"
				? `  CONVERT ${outcome.kind} ${outcome.name} -> ${outcome.destination}${detail.length ? ` (${detail.join("; ")})` : ""}`
				: `  UNSUPPORTED ${outcome.kind} ${outcome.name} (${outcome.source}): ${detail.join("; ")}`;
		}),
		...plan.unsupported.map((feature) => `  UNSUPPORTED ${feature}`),
		...plan.omitted.map((file) => `  SKIP ${file}: executable, host-specific, or non-text data.`),
		"Imported resources keep foreign trust and stay behind the project-import trust setting.",
		"Source files are never changed. Approval applies only to the displayed content.",
	];
	return lines.join("\n");
}
