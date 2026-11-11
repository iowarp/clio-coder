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
 *   4. Passes a DomainContext to each subsequent module that exposes getContract(name),
 *      which returns ONLY the published contract, never the full extension.
 *
 * Extensions are process-local. Contracts are the cross-domain surface. The
 * type of each contract comes from `DomainContractMap`, never from the caller.
 */

import type { DomainContractMap, DomainName } from "./domain-contracts.js";

import type { TelemetryHub } from "./telemetry/hub.js";
import { telemetryHub } from "./telemetry/hub.js";
import { resolveShutdownHookBudgetMs, runWithBudget, writeShutdownNotice } from "./termination.js";

export type { DomainContractMap, DomainName } from "./domain-contracts.js";

/** `D` is the name space `dependsOn` may cite; tests type a loader by their own map. */
export interface DomainManifest<N extends string = DomainName, D extends string = DomainName> {
	name: N;
	dependsOn: ReadonlyArray<D>;
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
 * The surface a domain publishes to other domains. Each domain defines its own
 * concrete contract type and `DomainContractMap` names it.
 */
export type DomainContract = object;

export interface DomainBundle<TContract = DomainContract> {
	extension: DomainExtension;
	contract: TContract;
}

type NameIn<M> = keyof M & string;

export interface DomainContext<M = DomainContractMap> {
	bus: TelemetryHub;
	getContract<N extends NameIn<M>>(name: N): M[N] | undefined;
}

/** A module whose manifest name is `N` and whose bundle publishes `M[N]`. */
export interface NamedDomainModule<N extends NameIn<M>, M = DomainContractMap> {
	manifest: DomainManifest<N, NameIn<M>>;
	createExtension(context: DomainContext<M>): DomainBundle<M[N]> | Promise<DomainBundle<M[N]>>;
}

/**
 * Any module of the map, as a union discriminated by manifest name, so a list
 * entry is checked against the contract its own name declares.
 */
export type DomainModule<N extends DomainName = DomainName> = { [K in N]: NamedDomainModule<K> }[N];

type AnyDomainModule<M> = { [K in NameIn<M>]: NamedDomainModule<K, M> }[NameIn<M>];

export interface LoadResult<M = DomainContractMap> {
	loaded: ReadonlyArray<string>;
	failed: ReadonlyArray<{ name: string; error: unknown }>;
	getContract<N extends NameIn<M>>(name: N): M[N] | undefined;
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

export async function loadDomains<M extends object = DomainContractMap>(
	modules: ReadonlyArray<AnyDomainModule<NoInfer<M>>>,
	options: LoadDomainsOptions = {},
): Promise<LoadResult<M>> {
	const order = topoSort(modules);
	// Written only under the module's own manifest name with the bundle its
	// NamedDomainModule type fixes to M[name], which is what makes the read cast sound.
	const contracts = new Map<string, unknown>();
	const lookup = <N extends NameIn<M>>(name: N): M[N] | undefined => contracts.get(name) as M[N] | undefined;
	const extensions = new Map<string, DomainExtension>();
	const loaded: string[] = [];
	const failed: Array<{ name: string; error: unknown }> = [];
	const bus = telemetryHub();

	const context: DomainContext<M> = { bus, getContract: lookup };

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
			// The default diagnostic already put the cause on stderr; a CLI that prints
			// the thrown error uses the short form instead of repeating it.
			throw new DomainLoadError(name, error, options.diagnostic === undefined);
		}
	}

	return { loaded, failed, getContract: lookup, stop };
}

function topoSort(modules: ReadonlyArray<{ manifest: DomainManifest<string, string> }>): string[] {
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
		reported = false,
	) {
		super(`Domain '${domain}' failed to load: ${cause instanceof Error ? cause.message : String(cause)}`);
		this.name = "DomainLoadError";
		if (reported) this.reportedSummary = `Domain '${domain}' failed to load; the cause is printed above`;
	}

	/** Set when the cause already reached stderr, so the CLI prints this line instead of the whole message. */
	readonly reportedSummary?: string;
}
