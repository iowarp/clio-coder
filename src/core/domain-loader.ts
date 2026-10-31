/**
 * Manifest-driven domain loader.
 *
 * Every domain module exports:
 *   { manifest, createExtension: (ctx) => { extension, contract } }
 *
 * The loader:
 *   1. Performs a topological sort on manifest dependencies.
 *   2. Instantiates each module in order, calling createExtension(ctx).
 *   3. Calls extension.start() and stores the contract under the domain name.
 *   4. Passes a DomainContext to each subsequent module that exposes getContract<T>(name),
 *      which returns ONLY the query-only contract, never the full extension.
 *
 * Extensions are process-local. Contracts are the cross-domain surface.
 */

import type { TelemetryHub } from "./telemetry/hub.js";
import { telemetryHub } from "./telemetry/hub.js";
import { resolveShutdownHookBudgetMs, runWithBudget, writeShutdownNotice } from "./termination.js";

export interface DomainManifest {
	name: string;
	dependsOn: ReadonlyArray<string>;
}

/**
 * Internal lifecycle surface. Not exposed to other domains.
 */
export interface DomainExtension {
	start(): Promise<void> | void;
	/** The loader passes its stop signal; a direct caller with nothing to cancel may omit it. */
	stop?(signal?: AbortSignal): Promise<void> | void;
	/**
	 * Time beyond the shared hook budget that stop() needs. Durable writes now
	 * yield to libuv, so a slow filesystem can outlast the flat budget and an
	 * abandoned stop would leak a lease or leave a row running (#428).
	 */
	stopAllowanceMs?(): number;
}

/**
 * Query-only surface exposed to other domains. Each domain's index.ts defines its
 * own concrete contract type and exports it alongside the module.
 */
export type DomainContract = object;

export interface DomainBundle<TContract extends DomainContract = DomainContract> {
	extension: DomainExtension;
	contract: TContract;
}

export interface DomainContext {
	bus: TelemetryHub;
	getContract<T extends DomainContract = DomainContract>(name: string): T | undefined;
}

export interface DomainModule<TContract extends DomainContract = DomainContract> {
	manifest: DomainManifest;
	createExtension(context: DomainContext): DomainBundle<TContract> | Promise<DomainBundle<TContract>>;
}

export interface LoadResult {
	loaded: ReadonlyArray<string>;
	failed: ReadonlyArray<{ name: string; error: unknown }>;
	getContract<T extends DomainContract = DomainContract>(name: string): T | undefined;
	stop(signal?: AbortSignal): Promise<void>;
}

export interface LoadDomainsOptions {
	diagnostic?: (text: string) => void;
	/**
	 * Awaited before each domain is created. Interactive boot turns the event
	 * loop here so the Stage 0 shell answers input between domain starts. A
	 * rejection is a cancellation, not a domain failure: every domain already
	 * started is stopped and the rejection propagates unchanged.
	 */
	beforeEach?: () => Promise<void>;
}

export async function loadDomains(
	modules: ReadonlyArray<DomainModule>,
	options: LoadDomainsOptions = {},
): Promise<LoadResult> {
	const order = topoSort(modules);
	const contracts = new Map<string, DomainContract>();
	const extensions = new Map<string, DomainExtension>();
	const loaded: string[] = [];
	const failed: Array<{ name: string; error: unknown }> = [];
	const bus = telemetryHub();

	const context: DomainContext = {
		bus,
		getContract<T extends DomainContract>(dep: string): T | undefined {
			return contracts.get(dep) as T | undefined;
		},
	};

	const stopAll = async (signal?: AbortSignal): Promise<void> => {
		const debug = process.env.CLIO_CODER_DEBUG_SHUTDOWN === "1";
		const baseBudgetMs = resolveShutdownHookBudgetMs();
		for (const [name, ext] of [...extensions].reverse()) {
			if (!ext.stop) continue;
			const budgetMs = Math.min(2 ** 31 - 1, baseBudgetMs + (ext.stopAllowanceMs?.() ?? 0));
			const stopFn = ext.stop.bind(ext);
			const t0 = debug ? process.hrtime.bigint() : 0n;
			const completed = await runWithBudget(
				stopFn,
				budgetMs,
				(err) => {
					const message = err instanceof Error ? err.message : String(err);
					writeShutdownNotice(`[clio-coder:domain-loader] ${name}.stop() failed: ${message}`);
					if (debug && err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
				},
				signal,
			);
			if (!completed) {
				writeShutdownNotice(`[clio-coder:domain-loader] ${name}.stop() exceeded ${budgetMs}ms budget; abandoning`);
			}
			if (debug) {
				const dt = Number(process.hrtime.bigint() - t0) / 1e6;
				process.stderr.write(
					`[clio-coder:shutdown]   domain.${name} ${dt.toFixed(1)}ms${completed ? "" : " (timed out)"}\n`,
				);
			}
		}
		extensions.clear();
		contracts.clear();
	};
	let stopping: Promise<void> | undefined;
	const stop = (signal?: AbortSignal): Promise<void> => (stopping ??= stopAll(signal));

	for (const name of order) {
		const mod = modules.find((m) => m.manifest.name === name);
		if (!mod) continue;
		if (options.beforeEach) {
			try {
				await options.beforeEach();
			} catch (cancellation) {
				await stop();
				throw cancellation;
			}
		}
		try {
			const bundle = await mod.createExtension(context);
			// A rejected start may already own listeners or other resources.
			extensions.set(name, bundle.extension);
			await bundle.extension.start();
			contracts.set(name, bundle.contract);
			loaded.push(name);
			bus.emit("domain.loaded", { name });
		} catch (error) {
			failed.push({ name, error });
			bus.emit("domain.failed", { name, error });
			await stop();
			const message = error instanceof Error ? error.message : String(error);
			(options.diagnostic ?? ((text: string) => process.stderr.write(text)))(
				`[clio-coder:domain] load failed: ${name}: ${message}\n`,
			);
			throw new DomainLoadError(name, error);
		}
	}

	const getContract = <T extends DomainContract = DomainContract>(name: string): T | undefined => {
		return contracts.get(name) as T | undefined;
	};

	return { loaded, failed, getContract, stop };
}

function topoSort(modules: ReadonlyArray<DomainModule>): string[] {
	const names = new Set<string>();
	for (const { manifest } of modules) {
		if (names.has(manifest.name)) {
			throw new DomainLoadError("topo", new Error(`Duplicate domain: ${manifest.name}`));
		}
		names.add(manifest.name);
	}
	const unresolved: string[] = [];
	for (const m of modules) {
		for (const dep of m.manifest.dependsOn) {
			if (!names.has(dep)) unresolved.push(`${m.manifest.name} -> ${dep}`);
		}
	}
	if (unresolved.length > 0) {
		throw new DomainLoadError("topo", new Error(`Unresolved dependencies: ${unresolved.join(", ")}`));
	}

	const order: string[] = [];
	const visited = new Set<string>();
	const visiting = new Set<string>();

	const visit = (name: string): void => {
		if (visited.has(name)) return;
		if (visiting.has(name)) {
			throw new DomainLoadError("topo", new Error(`Cycle detected at ${name}`));
		}
		visiting.add(name);
		const mod = modules.find((m) => m.manifest.name === name);
		if (mod) {
			for (const dep of mod.manifest.dependsOn) visit(dep);
		}
		visiting.delete(name);
		visited.add(name);
		order.push(name);
	};

	for (const m of modules) visit(m.manifest.name);
	return order;
}

class DomainLoadError extends Error {
	constructor(
		public readonly domain: string,
		public override readonly cause: unknown,
	) {
		super(`Domain '${domain}' failed to load: ${cause instanceof Error ? cause.message : String(cause)}`);
		this.name = "DomainLoadError";
	}
}
