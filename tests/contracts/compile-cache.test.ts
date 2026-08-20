import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createCompileCache,
	deleteInjectedCompileCacheFrom,
	INJECTED_COMPILE_CACHE_ENV,
	workerCompileCacheEnvironment,
} from "../../src/core/compile-cache.js";

type EnableFn = Parameters<typeof createCompileCache>[0];

describe("contracts/compile cache", () => {
	it("settles null when the operator disabled the cache, and never retries", () => {
		const calls: unknown[] = [];
		const cache = createCompileCache(((options?: unknown) => {
			calls.push(options);
			return { status: 0, directory: "/never" };
		}) as EnableFn);
		strictEqual(cache.enable({ NODE_DISABLE_COMPILE_CACHE: "1" }), null);
		// A later call with a permissive env must return the settled outcome,
		// not enable the cache after the fact.
		strictEqual(cache.enable({}), null);
		strictEqual(cache.directory(), null);
		deepStrictEqual(calls, [], "Node's enableCompileCache is never consulted");
	});

	it("enables under Clio's cache dir once and memoizes the directory", () => {
		const calls: unknown[] = [];
		const cache = createCompileCache(
			((options?: unknown) => {
				calls.push(options);
				return { status: 0, directory: "/cache/v8" };
			}) as EnableFn,
			() => true,
		);
		strictEqual(cache.enable({}), "/cache/v8");
		strictEqual(cache.directory(), "/cache/v8");
		// Settled: neither a disable nor a repeat re-negotiates with Node.
		strictEqual(cache.enable({ NODE_DISABLE_COMPILE_CACHE: "1" }), "/cache/v8");
		strictEqual(calls.length, 1);
		strictEqual(typeof calls[0], "string", "Clio names its default directory");
	});

	it("writes nothing to a home Clio never set up", () => {
		// `paths` and bare `doctor` promise an untouched home stays untouched,
		// and enabling the cache creates its directory; a missing cache root
		// settles null without consulting Node at all.
		const calls: unknown[] = [];
		const cache = createCompileCache(
			((options?: unknown) => {
				calls.push(options);
				return { status: 0, directory: "/never" };
			}) as EnableFn,
			() => false,
		);
		strictEqual(cache.enable({}), null);
		strictEqual(cache.enable({}), null);
		deepStrictEqual(calls, []);
	});

	it("defers to an operator-supplied NODE_COMPILE_CACHE", () => {
		const calls: unknown[] = [];
		const cache = createCompileCache(
			((options?: unknown) => {
				calls.push(options);
				return { status: 0, directory: "/operator/dir" };
			}) as EnableFn,
			// The operator asked; whether Clio's own root exists is irrelevant.
			() => false,
		);
		strictEqual(cache.enable({ NODE_COMPILE_CACHE: "/operator/dir" }), "/operator/dir");
		deepStrictEqual(calls, [undefined], "no argument, so Node reads the operator's env var");
	});

	it("treats an empty NODE_COMPILE_CACHE as the operator speaking, not as Clio's turn", () => {
		// Presence wins, matching the worker boundary's check: Node interprets
		// the empty value itself and Clio never substitutes its default.
		const calls: unknown[] = [];
		const cache = createCompileCache(
			((options?: unknown) => {
				calls.push(options);
				return { status: 0 };
			}) as EnableFn,
			() => true,
		);
		strictEqual(cache.enable({ NODE_COMPILE_CACHE: "" }), null);
		deepStrictEqual(calls, [undefined], "no argument, and never Clio's default directory");
	});

	it("settles null on failure instead of throwing or retrying", () => {
		let calls = 0;
		const cache = createCompileCache(
			(() => {
				calls += 1;
				throw new Error("cache backend unavailable");
			}) as EnableFn,
			() => true,
		);
		strictEqual(cache.enable({}), null);
		strictEqual(cache.enable({}), null);
		strictEqual(calls, 1);
	});

	it("scrubs exactly the Clio-injected pair from a child env", () => {
		// The marker's value is the injected directory; only a matching pair
		// is Clio's own injection.
		const injected: NodeJS.ProcessEnv = {
			PATH: "/usr/bin",
			NODE_COMPILE_CACHE: "/clio/cache/v8",
			[INJECTED_COMPILE_CACHE_ENV]: "/clio/cache/v8",
		};
		deleteInjectedCompileCacheFrom(injected);
		deepStrictEqual(injected, { PATH: "/usr/bin" });

		// An operator's own value carries no marker and must survive.
		const operator: NodeJS.ProcessEnv = { PATH: "/usr/bin", NODE_COMPILE_CACHE: "/operator/dir" };
		deleteInjectedCompileCacheFrom(operator);
		deepStrictEqual(operator, { PATH: "/usr/bin", NODE_COMPILE_CACHE: "/operator/dir" });

		// A stale or spoofed marker next to an operator's value removes only
		// itself; operator settings always win.
		const stale: NodeJS.ProcessEnv = {
			PATH: "/usr/bin",
			NODE_COMPILE_CACHE: "/operator/dir",
			[INJECTED_COMPILE_CACHE_ENV]: "/clio/cache/v8",
		};
		deleteInjectedCompileCacheFrom(stale);
		deepStrictEqual(stale, { PATH: "/usr/bin", NODE_COMPILE_CACHE: "/operator/dir" });
	});

	it("builds a worker env that injects the bound pair only when the operator left the cache alone", () => {
		// Nothing operator-set and a parent cache: inject the bound pair.
		deepStrictEqual(workerCompileCacheEnvironment({ PATH: "/usr/bin" }, "/clio/cache/v8"), {
			PATH: "/usr/bin",
			NODE_COMPILE_CACHE: "/clio/cache/v8",
			[INJECTED_COMPILE_CACHE_ENV]: "/clio/cache/v8",
		});

		// A parent that never enabled the cache adds nothing.
		const untouched: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
		strictEqual(workerCompileCacheEnvironment(untouched, null), untouched);

		// Operator controls pass through alone; a preexisting marker never
		// travels, so a worker can never see a marker beside operator values.
		deepStrictEqual(
			workerCompileCacheEnvironment(
				{ PATH: "/usr/bin", NODE_COMPILE_CACHE: "/operator/dir", [INJECTED_COMPILE_CACHE_ENV]: "/stale" },
				"/clio/cache/v8",
			),
			{ PATH: "/usr/bin", NODE_COMPILE_CACHE: "/operator/dir" },
		);
		deepStrictEqual(
			workerCompileCacheEnvironment(
				{ PATH: "/usr/bin", NODE_DISABLE_COMPILE_CACHE: "1", [INJECTED_COMPILE_CACHE_ENV]: "/stale" },
				"/clio/cache/v8",
			),
			{ PATH: "/usr/bin", NODE_DISABLE_COMPILE_CACHE: "1" },
		);
	});

	it("cannot lose an operator cache even when a spoofed marker matches its value", () => {
		// The adversarial chain: a marker equal to the operator's directory
		// arrives at the spawn boundary. Normalization strips the marker, so
		// the scrub the worker entry runs afterwards has nothing to match and
		// every descendant keeps the operator's cache.
		const spoofed: NodeJS.ProcessEnv = {
			PATH: "/usr/bin",
			NODE_COMPILE_CACHE: "/operator/dir",
			[INJECTED_COMPILE_CACHE_ENV]: "/operator/dir",
		};
		const workerEnv = { ...workerCompileCacheEnvironment(spoofed, "/clio/cache/v8") };
		deepStrictEqual(workerEnv, { PATH: "/usr/bin", NODE_COMPILE_CACHE: "/operator/dir" });
		deleteInjectedCompileCacheFrom(workerEnv);
		deepStrictEqual(workerEnv, { PATH: "/usr/bin", NODE_COMPILE_CACHE: "/operator/dir" });
	});
});
