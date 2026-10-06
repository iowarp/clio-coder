/**
 * The conversion from the pre-playbook layout to the canonical one, shared by
 * the user-home migration (`2026-10-06-playbooks-and-packages`) and the
 * once-per-workspace conversion of a project's `.clio-coder/`.
 *
 * Nothing here deletes operator data. A playbook that collides with one already
 * in `playbooks/` stays where it was and the leftover directory is moved aside
 * with a dated suffix. A package the Library no longer vouches for stays
 * installed and is named in the report with the exact fix. A package the
 * conversion replaces keeps any copy the operator had edited, because the
 * package writers retain a backup of bytes that differ from their install
 * record.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { LifecycleContext } from "../../core/library-receipts.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { withStateFileLockSync } from "../../core/state-file-lock.js";
import { clioConfigDir, clioStateDir } from "../../core/xdg.js";
import {
	capabilityEnvelope,
	disableExtension,
	envelopeDigest,
	extensionBaseDir,
	loadManifestFromRoot,
} from "../extensions/index.js";
import { bundledPluginCatalog } from "../plugins/catalog.js";
import { pluginBaseDir, pluginStatePath, withPluginScopeLock } from "../plugins/index.js";
import { olderClioDeclaration, olderClioMessage, WTFP_PLUGIN_NAME } from "../plugins/older-clio.js";
import type { PluginScope } from "../plugins/types.js";
import { commitLibraryInstallPlan, planLibraryInstall, releaseLibraryPlan } from "../resources/library.js";
import type { LibraryPackageEntry } from "../resources/library-types.js";

export interface ConversionReport {
	/** What the conversion changed, one line each. */
	changed: string[];
	/** What the operator still has to do, one line each with the exact fix. */
	attention: string[];
}

/** Every package the conversion installs or replaces is attributed to the upgrade in the receipt store. */
const UPGRADE: LifecycleContext = { actor: "upgrade" };
const PLUGIN_NAMESPACE = "ai.iowarp.clio";
const WORKSPACE_MARKER_LIMIT = 512;

export function emptyReport(): ConversionReport {
	return { changed: [], attention: [] };
}

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

function shown(file: string): string {
	const home = homedir();
	return file === home || file.startsWith(`${home}${path.sep}`) ? `~${file.slice(home.length)}` : file;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJson(file: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		return record(parsed) ? parsed : null;
	} catch {
		// Absent or unreadable state is not this conversion's to repair; the strict readers name it.
		return null;
	}
}

function sameBytes(left: string, right: string): boolean {
	try {
		const a = lstatSync(left);
		const b = lstatSync(right);
		return a.isFile() && b.isFile() && a.size === b.size && readFileSync(left).equals(readFileSync(right));
	} catch {
		return false;
	}
}

function asideName(directory: string): string {
	const base = `${directory}.${today()}`;
	if (!existsSync(base)) return base;
	for (let counter = 2; ; counter += 1) {
		const candidate = `${base}-${counter}`;
		if (!existsSync(candidate)) return candidate;
	}
}

/** Merge `from/` into `to/` without overwriting. A name that exists in both stays in `from/`, which is then moved aside. */
function mergeDirectory(from: string, to: string, report: ConversionReport): void {
	if (!existsSync(from)) return;
	const stat = lstatSync(from);
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		const aside = asideName(from);
		renameSync(from, aside);
		report.attention.push(
			`${shown(from)} is not a directory, so it was moved to ${shown(aside)} unread; move its playbooks into ${shown(to)} by hand.`,
		);
		return;
	}
	mkdirSync(to, { recursive: true });
	const moved: string[] = [];
	const collisions: string[] = [];
	for (const name of readdirSync(from).sort()) {
		const source = path.join(from, name);
		const target = path.join(to, name);
		if (!lexists(target)) {
			renameSync(source, target);
			moved.push(name);
		} else if (sameBytes(source, target)) {
			rmSync(source);
		} else {
			collisions.push(name);
		}
	}
	if (collisions.length > 0) {
		const aside = asideName(from);
		renameSync(from, aside);
		report.attention.push(
			`${collisions.length} playbook${collisions.length === 1 ? "" : "s"} in ${shown(from)} share a name with one in ${shown(to)} (${collisions.join(", ")}); both were kept and the old copies are in ${shown(aside)}. Compare them and keep the one you want.`,
		);
	} else {
		rmSync(from, { recursive: true, force: true });
	}
	if (moved.length > 0)
		report.changed.push(
			`Moved ${moved.length} item${moved.length === 1 ? "" : "s"} from ${shown(from)} to ${shown(to)} (${moved.join(", ")}).`,
		);
}

function lexists(file: string): boolean {
	try {
		lstatSync(file);
		return true;
	} catch {
		// Absent or unreadable: nothing at this path can be assumed.
		return false;
	}
}

function asKind(value: unknown): string {
	return value === "fleet" ? "playbook" : typeof value === "string" ? value : "plugin";
}

/** `kind: fleet` in an install record becomes `playbook`; the strict state reader refuses the old name. */
function rewritePluginRecords(scope: PluginScope, cwd: string, report: ConversionReport): void {
	const file = pluginStatePath(scope, cwd);
	if (!existsSync(file)) return;
	withPluginScopeLock(scope, cwd, () => {
		const state = readJson(file);
		if (!state || !record(state.installed)) return;
		let rewritten = 0;
		for (const entry of Object.values(state.installed)) {
			if (record(entry) && entry.kind === "fleet") {
				entry.kind = "playbook";
				rewritten += 1;
			}
		}
		if (rewritten === 0) return;
		safeResourceWrite(file, `${JSON.stringify(state, null, 2)}\n`, {
			encoding: "utf8",
			backup: { suffix: `.pre-playbooks-${today()}` },
		});
		report.changed.push(
			`Rewrote ${rewritten} ${scope} plugin install record${rewritten === 1 ? "" : "s"} from kind fleet to playbook.`,
		);
	});
}

/** A user or project library index that names the fleet kind or a `fleet:<name>` requirement. */
function rewriteLibraryIndex(file: string, report: ConversionReport): void {
	if (!existsSync(file)) return;
	try {
		const text = readFileSync(file, "utf8");
		if (!/\bfleet\b/u.test(text)) return;
		const parsed: unknown = parseYaml(text);
		const rows = Array.isArray(parsed) ? parsed : record(parsed) && Array.isArray(parsed.entries) ? parsed.entries : null;
		if (rows === null) return;
		let rewritten = 0;
		const refs = (value: unknown): unknown =>
			Array.isArray(value)
				? value.map((ref) => (typeof ref === "string" && ref.startsWith("fleet:") ? `playbook:${ref.slice(6)}` : ref))
				: value;
		for (const row of rows) {
			if (!record(row)) continue;
			let touched = false;
			if (row.kind === "fleet") {
				row.kind = "playbook";
				touched = true;
			}
			if (Array.isArray(row.requires) && row.requires.some((ref) => String(ref).startsWith("fleet:"))) {
				row.requires = refs(row.requires);
				touched = true;
			}
			if (Array.isArray(row.provides))
				for (const hint of row.provides)
					if (record(hint) && hint.kind === "fleet") {
						hint.kind = "playbook";
						touched = true;
					}
			if (touched) rewritten += 1;
		}
		if (rewritten === 0) return;
		safeResourceWrite(file, stringifyYaml(parsed), {
			encoding: "utf8",
			backup: { suffix: `.pre-playbooks-${today()}` },
		});
		report.changed.push(
			`Rewrote ${rewritten} library index entr${rewritten === 1 ? "y" : "ies"} in ${shown(file)} from fleet to playbook.`,
		);
	} catch (error) {
		report.attention.push(
			`${shown(file)} could not be converted (${message(error)}); rename its fleet kinds to playbook by hand.`,
		);
	}
}

interface PackageScope {
	scope: PluginScope;
	cwd: string;
	library: ReadonlyArray<LibraryPackageEntry>;
	report: ConversionReport;
}

function libraryEntry(
	library: ReadonlyArray<LibraryPackageEntry>,
	kind: string,
	name: string,
): LibraryPackageEntry | undefined {
	return library.find((entry) => entry.kind === kind && entry.name === name);
}

/** Installed from the Library, and the Library's current copy ships inside this Clio: an upgrade never fetches a remote source. */
function replaceableFromLibrary(saved: unknown, entry: LibraryPackageEntry | undefined): entry is LibraryPackageEntry {
	return (
		entry !== undefined &&
		path.isAbsolute(entry.sourceUrl) &&
		record(saved) &&
		record(saved.origin) &&
		saved.origin.kind === "catalog"
	);
}

/** Replace one installed package with the Library's current copy. Returns the retained backup path on success. */
function replaceFromLibrary(
	ctx: PackageScope,
	entry: LibraryPackageEntry,
): { ok: true; backup?: string } | { ok: false; reason: string } {
	let plan: ReturnType<typeof planLibraryInstall> | undefined;
	try {
		plan = planLibraryInstall(entry, { cwd: ctx.cwd, scope: ctx.scope, force: true, lifecycle: UPGRADE });
		const result = commitLibraryInstallPlan(plan);
		const errors = result.diagnostics.filter((diagnostic) => diagnostic.type === "error");
		if (!result.plugin || errors.length > 0)
			return {
				ok: false,
				reason: errors.map((diagnostic) => diagnostic.message).join("; ") || "install did not complete",
			};
		return { ok: true, ...(result.recovery?.packageBackup ? { backup: result.recovery.packageBackup } : {}) };
	} catch (error) {
		return { ok: false, reason: message(error) };
	} finally {
		if (plan) releaseLibraryPlan(plan);
	}
}

function convertPlugins(ctx: PackageScope): void {
	const state = readJson(pluginStatePath(ctx.scope, ctx.cwd));
	if (!state || !record(state.installed)) return;
	const disabled = new Set(Array.isArray(state.disabled) ? state.disabled.map(String) : []);
	for (const [id, saved] of Object.entries(state.installed)) {
		const root = path.join(pluginBaseDir(ctx.scope, ctx.cwd), id);
		const manifest = readJson(path.join(root, "plugin.json"));
		const extensions = manifest && record(manifest.extensions) ? manifest.extensions : undefined;
		const namespace = extensions?.[PLUGIN_NAMESPACE];
		const declaration = olderClioDeclaration(namespace);
		const bundle = existsSync(path.join(root, "clio-coder-extension.yaml"));
		if (declaration === null && !bundle) continue;
		const kind = asKind(record(saved) ? (saved.kind ?? (record(namespace) ? namespace.kind : undefined)) : undefined);
		const entry = libraryEntry(ctx.library, kind, id);
		const version = typeof manifest?.version === "string" ? manifest.version : "unknown";
		if (!replaceableFromLibrary(saved, entry)) {
			const source = record(saved) && typeof saved.source === "string" ? saved.source : "<its source directory>";
			ctx.report.attention.push(
				declaration !== null
					? `${ctx.scope} plugin ${id}@${version} stays installed but does not load: ${olderClioMessage(id, declaration)}${id === WTFP_PLUGIN_NAME ? "." : `. After the fix, reinstall it with: clio-coder library install ${source} --${ctx.scope} --force`}`
					: `${ctx.scope} plugin ${id}@${version} carries an extension manifest, so it does not load. Split it into a plugin and an extension, then install each: clio-coder library install <plugin path> --${ctx.scope} --force and clio-coder extensions install <extension path> --${ctx.scope}`,
			);
			continue;
		}
		const replaced = replaceFromLibrary(ctx, entry);
		if (!replaced.ok) {
			ctx.report.attention.push(
				`${ctx.scope} ${kind}:${id}@${version} could not be replaced with the Library's ${entry.version ?? "current"} (${replaced.reason}); it stays installed and does not load. Retry with: clio-coder library install ${kind}:${id} --${ctx.scope} --force`,
			);
			continue;
		}
		ctx.report.changed.push(
			`Replaced ${ctx.scope} ${kind}:${id}@${version} with the Library's ${entry.version ?? "current"} copy.`,
		);
		if (replaced.backup)
			ctx.report.changed.push(
				`Kept your edited copy of ${id} at ${shown(replaced.backup)}; the replacement is the unedited Library copy.`,
			);
		if (!bundle) continue;
		// The old bundle was one package; the Library now ships the plugin and its extension separately.
		const serving = ctx.library.find((candidate) => candidate.kind === "extension" && candidate.plugin === id);
		if (!serving) {
			ctx.report.attention.push(
				`${ctx.scope} plugin ${id} was a bundle with a runtime, and the Library has no extension that serves it, so the runtime is gone; install one with: clio-coder extensions install <extension path> --${ctx.scope}`,
			);
			continue;
		}
		const installed = replaceFromLibrary(ctx, serving);
		if (!installed.ok) {
			ctx.report.attention.push(
				`${ctx.scope} extension:${serving.name} could not be installed (${installed.reason}); install it with: clio-coder library install extension:${serving.name} --${ctx.scope}`,
			);
			continue;
		}
		ctx.report.changed.push(
			`Installed ${ctx.scope} extension:${serving.name}@${serving.version ?? "current"} from the Library. Its capability envelope is bound to that copy; review it with /extensions.`,
		);
		if (disabled.has(id)) {
			disableExtension(serving.name, { cwd: ctx.cwd, scope: ctx.scope, lifecycle: UPGRADE });
			ctx.report.changed.push(`Kept extension:${serving.name} disabled, as the bundle was.`);
		}
	}
}

/** An api 2 extension installed before the envelope binding has no recorded envelope and does not load. */
function convertExtensions(ctx: PackageScope): void {
	const base = extensionBaseDir(ctx.scope, ctx.cwd);
	const state = readJson(path.join(base, "state.json"));
	if (!state || !record(state.installed)) return;
	const disabled = new Set(Array.isArray(state.disabled) ? state.disabled.map(String) : []);
	for (const [id, saved] of Object.entries(state.installed)) {
		const root = path.join(base, id);
		if (!existsSync(root) || !record(saved)) continue;
		const manifest = loadManifestFromRoot(root).manifest;
		if (!manifest?.runtimeV2) continue;
		const current = envelopeDigest(capabilityEnvelope(manifest.runtimeV2, manifest.plugin));
		if (saved.envelopeDigest === current) continue;
		const entry = libraryEntry(ctx.library, "extension", id);
		if (!replaceableFromLibrary(saved, entry)) {
			const source = typeof saved.source === "string" ? saved.source : "<its source directory>";
			ctx.report.attention.push(
				`${ctx.scope} extension ${id}@${manifest.version} was installed before capability envelopes were bound, so it does not load. Reinstall it and review what it may do: clio-coder extensions install ${source} --${ctx.scope} --force`,
			);
			continue;
		}
		const replaced = replaceFromLibrary(ctx, entry);
		if (!replaced.ok) {
			ctx.report.attention.push(
				`${ctx.scope} extension:${id}@${manifest.version} could not be reinstalled from the Library (${replaced.reason}); it does not load. Retry with: clio-coder library install extension:${id} --${ctx.scope} --force`,
			);
			continue;
		}
		ctx.report.changed.push(
			`Reinstalled ${ctx.scope} extension:${id}@${manifest.version} from the Library with its capability envelope bound; review it with /extensions.`,
		);
		if (replaced.backup)
			ctx.report.changed.push(`Kept your edited copy of extension ${id} at ${shown(replaced.backup)}.`);
		if (disabled.has(id)) disableExtension(id, { cwd: ctx.cwd, scope: ctx.scope, lifecycle: UPGRADE });
	}
}

function convertPackages(scope: PluginScope, cwd: string, report: ConversionReport): void {
	rewritePluginRecords(scope, cwd, report);
	const library = bundledPluginCatalog([]);
	const ctx: PackageScope = { scope, cwd, library, report };
	try {
		convertPlugins(ctx);
	} catch (error) {
		report.attention.push(
			`${scope} plugins could not be converted (${message(error)}); run clio-coder library list to see their state.`,
		);
	}
	try {
		convertExtensions(ctx);
	} catch (error) {
		report.attention.push(
			`${scope} extensions could not be converted (${message(error)}); run clio-coder extensions list to see their state.`,
		);
	}
}

/** The user home: `<configDir>/fleets`, the plugin and extension install records, and the user library index. */
export function convertUserHome(): ConversionReport {
	const report = emptyReport();
	const config = clioConfigDir();
	try {
		mergeDirectory(path.join(config, "fleets"), path.join(config, "playbooks"), report);
	} catch (error) {
		report.attention.push(
			`${shown(path.join(config, "fleets"))} could not be moved (${message(error)}); move its playbooks into ${shown(path.join(config, "playbooks"))} by hand.`,
		);
	}
	rewriteLibraryIndex(path.join(config, "library.yaml"), report);
	convertPackages("user", process.cwd(), report);
	return report;
}

interface WorkspaceMarkers {
	version: 1;
	workspaces: Record<string, string>;
}

function markerPath(): string {
	return path.join(clioStateDir(), "workspace-conversions.json");
}

function readMarkers(): WorkspaceMarkers {
	const parsed = readJson(markerPath());
	return parsed && parsed.version === 1 && record(parsed.workspaces)
		? { version: 1, workspaces: parsed.workspaces as Record<string, string> }
		: { version: 1, workspaces: {} };
}

/**
 * A workspace's `.clio-coder/`, converted the first time Clio opens it: `fleets/`
 * becomes `playbooks/` and the project's install records and packages follow the
 * same rules as the user home. Returns null when there was nothing to convert or
 * the workspace was converted before.
 */
export function convertWorkspaceOnce(workspace: string): ConversionReport | null {
	let root: string;
	try {
		root = realpathSync(workspace);
	} catch {
		// A workspace that cannot be resolved has no layout to convert.
		return null;
	}
	const project = path.join(root, ".clio-coder");
	const legacy = existsSync(path.join(project, "fleets"));
	const packages =
		existsSync(path.join(project, "plugins", "state.json")) || existsSync(path.join(project, "extensions", "state.json"));
	const index = existsSync(path.join(project, "library.yaml"));
	if (!legacy && !packages && !index) return null;
	if (readMarkers().workspaces[root] !== undefined) return null;
	const report = emptyReport();
	try {
		mergeDirectory(path.join(project, "fleets"), path.join(project, "playbooks"), report);
	} catch (error) {
		report.attention.push(
			`${shown(path.join(project, "fleets"))} could not be moved (${message(error)}); move its playbooks into ${shown(path.join(project, "playbooks"))} by hand.`,
		);
	}
	rewriteLibraryIndex(path.join(project, "library.yaml"), report);
	convertPackages("project", root, report);
	try {
		withStateFileLockSync(markerPath(), () => {
			const markers = readMarkers();
			markers.workspaces[root] = new Date().toISOString();
			const kept = Object.entries(markers.workspaces).slice(-WORKSPACE_MARKER_LIMIT);
			safeResourceWrite(
				markerPath(),
				`${JSON.stringify({ version: 1, workspaces: Object.fromEntries(kept) }, null, 2)}\n`,
				{
					encoding: "utf8",
					mode: 0o600,
				},
			);
		});
	} catch (error) {
		report.attention.push(
			`The conversion of this workspace could not be recorded (${message(error)}), so Clio checks it again next time.`,
		);
	}
	return report.changed.length === 0 && report.attention.length === 0 ? null : report;
}

/** One line for the TUI notice: what changed, then what still needs the operator. */
export function describeConversion(report: ConversionReport, subject: string): string {
	const parts: string[] = [];
	if (report.changed.length > 0)
		parts.push(`clio-coder converted ${subject} to the playbooks layout. ${report.changed.join(" ")}`);
	if (report.attention.length > 0) parts.push(`Needs you: ${report.attention.join(" ")}`);
	return parts.join(" ");
}
