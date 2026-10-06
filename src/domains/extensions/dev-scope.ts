import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerDevRoot, releaseDevRoots } from "../../core/dev-roots.js";
import { recordPackageActivity } from "../../core/package-activity.js";
import { projectPackagesTrusted } from "../../core/workspace-trust.js";
import { extensionIdentity } from "./activity.js";
import { evaluateClioCompatibility } from "./compatibility.js";
import { findExtensionManifestPath, loadManifestFromRoot } from "./discovery.js";
import { extensionContentDigestWithCapture } from "./integrity.js";
import type { ExtensionCapabilityEnvelope } from "./manifest-v2.js";
import { capabilityEnvelope, envelopeDigest, envelopeGrowth } from "./runtime-schema-v2.js";
import type { ExtensionSessionOverlay, InstalledExtensionRecord } from "./state.js";
import { listInstalledExtensions } from "./state.js";
import type { ExtensionDiagnostic, InstalledExtension } from "./types.js";

/** Where Clio looks for packages under development, relative to the workspace. */
export const DEV_EXTENSIONS_DIR = path.join(".clio-coder", "dev", "extensions");

/** One consent question the host asks the operator; never a permission rule or a model answer. */
export interface DevConsentRequest {
	id: string;
	name: string;
	source: string;
	envelope: ExtensionCapabilityEnvelope;
	digest: string;
	/** Null on a first approval; otherwise how the envelope reaches past the one approved. */
	growth: string[] | null;
}

export type DevExtensionState = "approved" | "pending" | "declined" | "invalid";

export interface DevExtensionStatus {
	id: string;
	source: string;
	state: DevExtensionState;
	muted: boolean;
	diagnostics: string[];
	/** Why the last save was not loaded; the previous valid copy is still the one loaded. */
	failure?: string;
}

/** What one refresh did: ids whose loaded copy changed, and saves kept out because they did not build. */
export interface DevRefresh {
	changed: string[];
	failed: Array<{ id: string; message: string }>;
}

interface DevCopy {
	source: string;
	/** Digest of the source tree when it was copied; a save changes it. */
	sourceDigest: string;
	copyRoot: string;
	record: InstalledExtensionRecord;
	envelope: ExtensionCapabilityEnvelope | null;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function invalid(source: string, id: string, diagnostics: ExtensionDiagnostic[]): InstalledExtensionRecord {
	return {
		entry: {
			id,
			name: id,
			version: "0.0.0",
			description: "",
			scope: "dev",
			rootPath: source,
			manifestPath: findExtensionManifestPath(source) ?? source,
			enabled: true,
			valid: false,
			compatible: true,
			effective: false,
			loadable: false,
			devSource: source,
			diagnostics,
		},
	};
}

/**
 * Extension packages the operator is developing, loaded for one terminal
 * session. Each refresh copies a changed folder to a private directory and
 * loads the copy, so a save during a generation cannot change the code that
 * generation runs. A package loads only after the operator approves its
 * capability envelope for this session; one whose envelope later grows waits
 * for approval again, and a same or smaller one reloads without asking.
 * Nothing here is persisted, and only the terminal constructs one.
 */
export class ExtensionDevScope implements ExtensionSessionOverlay {
	private readonly roots = new Set<string>();
	/** Folders another live session registered first, with the sentence that says so. */
	private readonly refused = new Map<string, string>();
	private readonly copies = new Map<string, DevCopy>();
	private readonly approved = new Map<string, ExtensionCapabilityEnvelope>();
	private readonly declined = new Map<string, string>();
	private readonly mutedIds = new Set<string>();
	private readonly retired = new Set<string>();
	/** The source digest of a save that did not build, so the same bytes are not tried and reported twice. */
	private readonly failed = new Map<string, { digest: string; message: string }>();

	constructor(private readonly cwd: () => string) {}

	/**
	 * Folders under the workspace's dev directory that hold a manifest. A cloned
	 * repository can ship one, so they are claimed only in a workspace whose
	 * project extensions the operator approved; `add` stays the explicit path.
	 */
	discover(): string[] {
		if (!projectPackagesTrusted(this.cwd(), "extensions")) return [];
		const found: string[] = [];
		for (const root of this.devFolders()) {
			if (this.roots.has(root)) continue;
			if (this.claim(root) !== null) continue;
			found.push(root);
		}
		return found;
	}

	/** Dev folders `discover` skips because the workspace's project extensions are not approved. */
	withheld(): string[] {
		return projectPackagesTrusted(this.cwd(), "extensions")
			? []
			: this.devFolders().filter((root) => !this.roots.has(root));
	}

	private devFolders(): string[] {
		const base = path.join(this.cwd(), DEV_EXTENSIONS_DIR);
		let names: string[];
		try {
			names = readdirSync(base).sort();
		} catch {
			// No dev directory yet; the model or the operator may create one later.
			return [];
		}
		const folders: string[] = [];
		for (const name of names) {
			const root = path.join(base, name);
			if (name.startsWith(".") || findExtensionManifestPath(root) === null) continue;
			try {
				if (!statSync(root).isDirectory()) continue;
			} catch {
				// Removed between listing and stat.
				continue;
			}
			folders.push(root);
		}
		return folders;
	}

	/**
	 * Register a folder for this session before it is loaded or watched. A folder
	 * another live session holds is not loaded here and its model may not write
	 * it; the session that registered it first keeps it until that process exits.
	 */
	private claim(root: string): string | null {
		const registered = registerDevRoot(root);
		if (registered.ok) {
			this.refused.delete(root);
			this.roots.add(root);
			return null;
		}
		const problem = `${root} is registered to another session (pid ${registered.heldBy.pid}); one session at a time develops a folder`;
		this.refused.set(root, problem);
		return problem;
	}

	/** A folder the operator names. Returns the problem, or null once it is a dev root. */
	add(folder: string): string | null {
		const root = path.resolve(this.cwd(), folder);
		if (!existsSync(root)) return `${root} does not exist`;
		if (findExtensionManifestPath(root) === null) return `${root} has no clio-coder-extension.yaml`;
		return this.roots.has(root) ? null : this.claim(root);
	}

	sources(): string[] {
		return [...this.roots];
	}

	/**
	 * Copy every folder whose tree changed since its last copy. Returns the
	 * ids whose copy changed, so the caller reloads only when something did.
	 */
	refresh(): DevRefresh {
		const changed: string[] = [];
		const failures: DevRefresh["failed"] = [];
		const seen = new Set<string>();
		// A save that does not build keeps the previous valid copy loaded, as
		// any failed generation keeps the one before it (SPEC 4.9).
		const keep = (source: string, before: DevCopy, digest: string, problem: string): void => {
			const id = before.record.entry.id;
			seen.add(id);
			if (this.failed.get(source)?.digest === digest) return;
			this.failed.set(source, { digest, message: problem });
			failures.push({ id, message: problem });
		};
		for (const source of this.roots) {
			if (!existsSync(source)) {
				const gone = this.copies.get(source);
				if (gone) {
					this.retire(gone.copyRoot);
					this.copies.delete(source);
					changed.push(gone.record.entry.id);
				}
				this.roots.delete(source);
				releaseDevRoots(source);
				continue;
			}
			const before = this.copies.get(source);
			let sourceDigest: string;
			try {
				sourceDigest = extensionContentDigestWithCapture(source).digest;
			} catch (error) {
				const problem = `dev folder could not be read: ${message(error)}`;
				if (before?.record.entry.valid) {
					keep(source, before, `unreadable:${problem}`, problem);
					continue;
				}
				const record = invalid(source, before?.record.entry.id ?? path.basename(source), [
					{ type: "error", message: problem, path: source },
				]);
				this.replace(source, { source, sourceDigest: "", copyRoot: "", record, envelope: null });
				changed.push(record.entry.id);
				continue;
			}
			if (before?.sourceDigest === sourceDigest) {
				seen.add(before.record.entry.id);
				continue;
			}
			if (before?.record.entry.valid && this.failed.get(source)?.digest === sourceDigest) {
				seen.add(before.record.entry.id);
				continue;
			}
			const next = this.copy(source, sourceDigest);
			if (seen.has(next.record.entry.id)) {
				next.record.entry.valid = false;
				next.record.entry.diagnostics.push({
					type: "error",
					message: `another dev folder already provides ${next.record.entry.id}`,
					path: source,
				});
			}
			if (!next.record.entry.valid && before?.record.entry.valid) {
				if (next.copyRoot) this.retire(next.copyRoot);
				const problem =
					next.record.entry.diagnostics.find((diagnostic) => diagnostic.type === "error")?.message ?? "invalid package";
				keep(source, before, sourceDigest, problem);
				continue;
			}
			seen.add(next.record.entry.id);
			this.failed.delete(source);
			this.replace(source, next);
			changed.push(next.record.entry.id);
		}
		this.applyConsent();
		return { changed, failed: failures };
	}

	private replace(source: string, next: DevCopy): void {
		const before = this.copies.get(source);
		if (before?.copyRoot) this.retire(before.copyRoot);
		this.copies.set(source, next);
	}

	/**
	 * A superseded copy stays until the next refresh, because a runtime that
	 * starts on first use copies from it after the reload that replaced it.
	 */
	private retire(copyRoot: string): void {
		for (const old of this.retired) {
			try {
				rmSync(old, { recursive: true, force: true });
			} catch {
				// Temporary bytes only; the next refresh or disposal tries again.
				continue;
			}
			this.retired.delete(old);
		}
		this.retired.add(copyRoot);
	}

	private copy(source: string, sourceDigest: string): DevCopy {
		const fallbackId = path.basename(source);
		const copyRoot = mkdtempSync(path.join(os.tmpdir(), "clio-coder-dev-extension-"));
		const root = path.join(copyRoot, "package");
		const failed = (text: string): DevCopy => ({
			source,
			sourceDigest,
			copyRoot,
			record: invalid(source, fallbackId, [{ type: "error", message: text, path: source }]),
			envelope: null,
		});
		try {
			cpSync(source, root, { recursive: true, dereference: false, verbatimSymlinks: true });
		} catch (error) {
			return failed(`dev folder could not be copied: ${message(error)}`);
		}
		const candidate = loadManifestFromRoot(root);
		const manifest = candidate.manifest;
		const manifestName = candidate.manifestPath ? path.basename(candidate.manifestPath) : undefined;
		let digest: string;
		let manifestBytes: Buffer | undefined;
		try {
			const read = extensionContentDigestWithCapture(root, { capture: manifestName ? [manifestName] : [] });
			digest = read.digest;
			manifestBytes = manifestName ? read.captured.get(manifestName) : undefined;
		} catch (error) {
			return failed(`dev copy could not be verified: ${message(error)}`);
		}
		if (digest !== sourceDigest) return failed("dev folder changed while it was copied; save again");
		const diagnostics: ExtensionDiagnostic[] = candidate.diagnostics.map((diagnostic) => ({
			...diagnostic,
			...(diagnostic.path ? { path: diagnostic.path.replace(root, source) } : {}),
		}));
		// The envelope is what the operator approves. A hooks.yaml command hook or
		// an api 1 runtime would run outside it, so a dev package carries neither.
		if (existsSync(path.join(root, "hooks.yaml")))
			diagnostics.push({ type: "error", message: "a dev package declares its hooks in the manifest, not hooks.yaml" });
		if (manifest?.runtime || manifest?.capabilities)
			diagnostics.push({ type: "error", message: "dev scope loads api 2 runtimes only" });
		if (manifest && !manifest.runtimeV2)
			diagnostics.push({ type: "error", message: "a dev package needs runtime.api: 2" });
		const clioRange = manifest?.compatibility?.clio;
		const entry: InstalledExtension = {
			...(manifest?.plugin ? { plugin: manifest.plugin } : {}),
			...(manifest?.runtimeV2 ? { runtimeV2: manifest.runtimeV2 } : {}),
			id: manifest?.id ?? fallbackId,
			name: manifest?.name ?? fallbackId,
			version: manifest?.version ?? "0.0.0",
			description: manifest?.description ?? "",
			scope: "dev",
			rootPath: root,
			manifestPath: candidate.manifestPath ?? root,
			enabled: true,
			valid: candidate.valid && !diagnostics.some((diagnostic) => diagnostic.type === "error"),
			compatible: clioRange === undefined || evaluateClioCompatibility(clioRange).satisfied,
			effective: false,
			loadable: false,
			devSource: source,
			diagnostics,
		};
		if (manifest && manifestBytes)
			entry.provenance = {
				id: manifest.id,
				scope: "dev",
				sourcePath: source,
				canonicalRoot: realpathSync(root),
				manifestDigest: createHash("sha256").update(manifestBytes).digest("hex"),
				contentDigest: digest,
			};
		else entry.valid = false;
		return {
			source,
			sourceDigest,
			copyRoot,
			record: { entry, ...(manifestName && manifestBytes ? { captured: new Map([[manifestName, manifestBytes]]) } : {}) },
			envelope: manifest?.runtimeV2 ? capabilityEnvelope(manifest.runtimeV2, manifest.plugin) : null,
		};
	}

	/** Mark every copy that waits for the operator. */
	private applyConsent(): void {
		for (const copy of this.copies.values()) {
			const entry = copy.record.entry;
			if (copy.envelope === null || !entry.valid) {
				delete entry.consentPending;
				continue;
			}
			const approved = this.approved.get(entry.id);
			if (approved !== undefined && envelopeGrowth(approved, copy.envelope).length === 0) delete entry.consentPending;
			else entry.consentPending = true;
		}
	}

	pendingConsent(): DevConsentRequest[] {
		const requests: DevConsentRequest[] = [];
		for (const copy of this.copies.values()) {
			const entry = copy.record.entry;
			if (!entry.consentPending || copy.envelope === null) continue;
			const digest = envelopeDigest(copy.envelope);
			if (this.declined.get(entry.id) === digest) continue;
			const approved = this.approved.get(entry.id);
			requests.push({
				id: entry.id,
				name: entry.name,
				source: copy.source,
				envelope: copy.envelope,
				digest,
				growth: approved === undefined ? null : envelopeGrowth(approved, copy.envelope),
			});
		}
		return requests;
	}

	/** Approval holds for this session only and covers any envelope the approved one covers. */
	approve(id: string, digest: string): boolean {
		const copy = [...this.copies.values()].find((entry) => entry.record.entry.id === id);
		if (!copy?.envelope || envelopeDigest(copy.envelope) !== digest) return false;
		this.approved.set(id, copy.envelope);
		this.declined.delete(id);
		this.applyConsent();
		this.activity(id, "dev_consent");
		return true;
	}

	decline(id: string, digest: string): void {
		this.declined.set(id, digest);
		this.activity(id, "dev_decline");
	}

	/** Ask again for every declined package. */
	reconsider(): void {
		this.declined.clear();
	}

	mute(id: string): void {
		if (!this.mutedIds.has(id)) this.activity(id, "mute");
		this.mutedIds.add(id);
	}

	unmute(id: string): boolean {
		const changed = this.mutedIds.delete(id);
		if (changed) this.activity(id, "unmute");
		return changed;
	}
	private activity(id: string, kind: string): void {
		try {
			const entry =
				[...this.copies.values()].find((copy) => copy.record.entry.id === id)?.record.entry ??
				listInstalledExtensions(this.cwd(), { all: true }).find((entry) => entry.id === id);
			if (entry) recordPackageActivity({ kind, owner: extensionIdentity(entry), outcome: "operator" });
		} catch {
			// Activity cannot change the operator's session-only consent or mute decision.
		}
	}

	isMuted(id: string): boolean {
		return this.mutedIds.has(id);
	}

	status(): DevExtensionStatus[] {
		const refused = [...this.refused].map(
			([source, problem]): DevExtensionStatus => ({
				id: path.basename(source),
				source,
				state: "invalid",
				muted: false,
				diagnostics: [problem],
			}),
		);
		return [...refused, ...this.copyStatus()];
	}

	private copyStatus(): DevExtensionStatus[] {
		return [...this.copies.values()].map((copy) => {
			const entry = copy.record.entry;
			const digest = copy.envelope ? envelopeDigest(copy.envelope) : "";
			return {
				id: entry.id,
				source: copy.source,
				state: !entry.valid
					? "invalid"
					: !entry.consentPending
						? "approved"
						: this.declined.get(entry.id) === digest
							? "declined"
							: "pending",
				muted: this.mutedIds.has(entry.id),
				diagnostics: entry.diagnostics.map((diagnostic) => diagnostic.message),
				...(this.failed.has(copy.source) ? { failure: this.failed.get(copy.source)?.message ?? "" } : {}),
			};
		});
	}

	devRecords(): InstalledExtensionRecord[] {
		// The listing mutates shadowing fields on the entries it returns, so each
		// call gets its own copy of the record.
		return [...this.copies.values()].map((copy) => ({
			...copy.record,
			entry: { ...copy.record.entry, diagnostics: [...copy.record.entry.diagnostics] },
		}));
	}

	muted(): ReadonlySet<string> {
		return this.mutedIds;
	}

	dispose(): void {
		releaseDevRoots();
		for (const copy of this.copies.values()) if (copy.copyRoot) this.retired.add(copy.copyRoot);
		this.copies.clear();
		for (const old of this.retired) {
			try {
				rmSync(old, { recursive: true, force: true });
			} catch {
				// Temporary bytes only; nothing reads them after disposal.
			}
		}
		this.retired.clear();
	}
}
