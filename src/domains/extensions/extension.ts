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
	 * makes prepare reentrancy-safe and lets a candidate tell whether it is
	 * still the one in flight.
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
			// Bind an empty store only. Until the composition root publishes the
			// boot generation together with its user hooks, every reader takes
			// the ephemeral generation-0 path, so no consumer can observe
			// extension resources paired with hooks from another generation.
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
			let snapshot: ReturnType<typeof build>;
			try {
				snapshot = build(generation);
			} catch (error) {
				return rejected("build-failed", failureDiagnostics(error));
			}
			const candidate: ExtensionReloadCandidate = {
				generation,
				previousGeneration: previous?.generation ?? 0,
				snapshot,
				...diffExtensionSnapshots(previous, snapshot),
				// Identity on the committed reference covers every intervening
				// publish; the in-flight check covers discard and double publish.
				current: () => inFlight === candidate && store.current() === previous,
				publish() {
					store.publish(snapshot);
					inFlight = null;
				},
				discard() {
					if (inFlight === candidate) inFlight = null;
				},
			};
			inFlight = candidate;
			return { status: "prepared", candidate };
		},
	};
	return { extension, contract };
}
