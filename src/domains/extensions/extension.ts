import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import type { ExtensionsContract } from "./contract.js";
import {
	disableExtension,
	discoverExtensionPackages,
	enabledExtensionResourceRoots,
	enableExtension,
	installExtension,
	listInstalledExtensions,
	removeExtension,
} from "./manager.js";
import {
	type BuildExtensionSnapshotInput,
	buildExtensionSnapshot,
	diffExtensionSnapshots,
	EXTENSION_SNAPSHOT_DIAGNOSTIC_MESSAGE_CAP,
} from "./snapshot.js";
import { bindExtensionSnapshotStore, createExtensionSnapshotStore } from "./snapshot-store.js";
import type {
	ExtensionReloadCandidate,
	ExtensionReloadRejection,
	ExtensionReloadRejectionReason,
	ExtensionSnapshotDiagnostics,
} from "./types.js";

/** Test seams only; the domain loader constructs the bundle with defaults. */
export interface ExtensionsBundleOptions {
	cwd?: () => string;
	now?: BuildExtensionSnapshotInput["now"];
	listRecords?: BuildExtensionSnapshotInput["listRecords"];
}

function failureDiagnostics(error: unknown): ExtensionSnapshotDiagnostics {
	const message = error instanceof Error ? error.message : String(error);
	return {
		entries: [{ type: "error", message: message.slice(0, EXTENSION_SNAPSHOT_DIAGNOSTIC_MESSAGE_CAP) }],
		truncated: 0,
	};
}

export function createExtensionsBundle(
	_context: DomainContext,
	options: ExtensionsBundleOptions = {},
): DomainBundle<ExtensionsContract> {
	const store = createExtensionSnapshotStore();
	const cwd = options.cwd ?? (() => process.cwd());
	const build = (generation: number) =>
		buildExtensionSnapshot({
			cwd: cwd(),
			generation,
			...(options.now !== undefined ? { now: options.now } : {}),
			...(options.listRecords !== undefined ? { listRecords: options.listRecords } : {}),
		});
	/**
	 * The single prepared-but-unpublished candidate. Holding it here is what
	 * makes prepare reentrancy-safe and lets commit refuse any candidate that
	 * is not the one currently in flight.
	 */
	let inFlight: ExtensionReloadCandidate | null = null;

	const rejected = (
		reason: ExtensionReloadRejectionReason,
		diagnostics: ExtensionSnapshotDiagnostics,
	): ExtensionReloadRejection => ({
		status: "rejected",
		reason,
		generation: store.current()?.generation ?? 0,
		diagnostics,
	});

	const extension: DomainExtension = {
		start() {
			const snapshot = build(store.nextGeneration());
			if (!store.commit(snapshot)) throw new Error("initial extension snapshot generation was stale");
			bindExtensionSnapshotStore(store);
		},
		stop() {
			inFlight = null;
			bindExtensionSnapshotStore(null);
		},
	};
	const contract: ExtensionsContract = {
		list(cwd, options = {}) {
			return listInstalledExtensions(cwd, options);
		},
		discover(root) {
			return discoverExtensionPackages(root);
		},
		install(root, options = {}) {
			return installExtension(root, options);
		},
		enable(id, options = {}) {
			return enableExtension(id, options);
		},
		disable(id, options = {}) {
			return disableExtension(id, options);
		},
		remove(id, options = {}) {
			return removeExtension(id, options);
		},
		resourceRoots(kind, requestedCwd) {
			return enabledExtensionResourceRoots(kind, requestedCwd ?? cwd());
		},
		snapshot() {
			return store.current();
		},
		generation() {
			return store.current()?.generation ?? 0;
		},
		prepareReload() {
			if (inFlight !== null) return rejected("reentrant", { entries: [], truncated: 0 });
			const previous = store.current();
			// Reserve before building so a discarded candidate burns its number
			// and generations stay strictly monotonic without a second counter.
			const generation = store.nextGeneration();
			let candidate: ExtensionReloadCandidate;
			try {
				const snapshot = build(generation);
				candidate = {
					generation,
					previousGeneration: previous?.generation ?? 0,
					snapshot,
					...diffExtensionSnapshots(previous, snapshot),
				};
			} catch (error) {
				return rejected("build-failed", failureDiagnostics(error));
			}
			inFlight = candidate;
			return { status: "prepared", candidate };
		},
		commitReload(candidate) {
			if (candidate !== inFlight) return rejected("stale", candidate.snapshot.diagnostics);
			inFlight = null;
			// One assignment inside the store publishes the generation. Nothing
			// between the stale check and the return can yield or throw.
			if (!store.commit(candidate.snapshot)) return rejected("stale", candidate.snapshot.diagnostics);
			return {
				status: "committed",
				generation: candidate.generation,
				previousGeneration: candidate.previousGeneration,
				changed: candidate.changed,
				digest: candidate.snapshot.digest,
				added: candidate.added,
				removed: candidate.removed,
				modified: candidate.modified,
				diagnostics: candidate.snapshot.diagnostics,
			};
		},
		discardReload(candidate) {
			if (candidate === inFlight) inFlight = null;
		},
	};
	return { extension, contract };
}
