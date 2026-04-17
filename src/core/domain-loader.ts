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

import { BusChannels } from "./bus-events.js";
import type { SafeEventBus } from "./event-bus.js";
import { getSharedBus } from "./shared-bus.js";

export interface DomainManifest {
	name: string;
	dependsOn: ReadonlyArray<string>;
}

/**
 * Internal lifecycle surface. Not exposed to other domains.
 */
export interface DomainExtension {
	start(): Promise<void> | void;
	stop?(): Promise<void> | void;
}

/**
 * Query-only surface exposed to other domains. Each domain's index.ts defines its
 * own concrete contract type and exports it alongside the module.
 */
export type DomainContract = Readonly<Record<string, unknown>>;

export interface DomainBundle<TContract extends DomainContract = DomainContract> {
	extension: DomainExtension;
	contract: TContract;
}

export interface DomainContext {
	bus: SafeEventBus;
	getContract<T extends DomainContract = DomainContract>(name: string): T | undefined;
}

export interface DomainModule<TContract extends DomainContract = DomainContract> {
	manifest: DomainManifest;
	createExtension(context: DomainContext): DomainBundle<TContract> | Promise<DomainBundle<TContract>>;
}

export interface LoadResult {
	loaded: ReadonlyArray<string>;
	failed: ReadonlyArray<{ name: string; error: unknown }>;
	stop(): Promise<void>;
}

export async function loadDomains(modules: ReadonlyArray<DomainModule>): Promise<LoadResult> {
	const order = topoSort(modules);
	const contracts = new Map<string, DomainContract>();
	const extensions = new Map<string, DomainExtension>();
	const loaded: string[] = [];
	const failed: Array<{ name: string; error: unknown }> = [];
	const bus = getSharedBus();

	const context: DomainContext = {
		bus,
		getContract<T extends DomainContract>(dep: string): T | undefined {
			return contracts.get(dep) as T | undefined;
		},
	};

	for (const name of order) {
		const mod = modules.find((m) => m.manifest.name === name);
		if (!mod) continue;
		try {
			const bundle = await mod.createExtension(context);
			await bundle.extension.start();
			extensions.set(name, bundle.extension);
			contracts.set(name, bundle.contract);
			loaded.push(name);
			bus.emit(BusChannels.DomainLoaded, { name });
		} catch (error) {
			failed.push({ name, error });
			bus.emit(BusChannels.DomainFailed, { name, error });
			throw new DomainLoadError(name, error);
		}
	}

	const stop = async (): Promise<void> => {
		for (const name of [...loaded].reverse()) {
			const ext = extensions.get(name);
			if (ext?.stop) {
				try {
					await ext.stop();
				} catch (err) {
					console.error(`[clio:domain-loader] ${name}.stop() failed:`, err);
				}
			}
		}
	};

	return { loaded, failed, stop };
}

function topoSort(modules: ReadonlyArray<DomainModule>): string[] {
	const names = new Set(modules.map((m) => m.manifest.name));
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

export class DomainLoadError extends Error {
	constructor(
		public readonly domain: string,
		public override readonly cause: unknown,
	) {
		super(`Domain '${domain}' failed to load: ${cause instanceof Error ? cause.message : String(cause)}`);
		this.name = "DomainLoadError";
	}
}
