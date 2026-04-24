import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { DomainBundle, DomainModule } from "../../src/core/domain-loader.js";
import { loadDomains } from "../../src/core/domain-loader.js";
import { DEFAULT_SHUTDOWN_HOOK_MS, resolveShutdownHookBudgetMs, runWithBudget } from "../../src/core/termination.js";

function makeDomain(
	name: string,
	opts: { dependsOn?: ReadonlyArray<string>; stop?: () => Promise<void> | void } = {},
): DomainModule {
	return {
		manifest: { name, dependsOn: opts.dependsOn ?? [] },
		createExtension(): DomainBundle {
			const extension: DomainBundle["extension"] = {
				async start() {},
				...(opts.stop ? { stop: opts.stop } : {}),
			};
			return { extension, contract: {} };
		},
	};
}

describe("core/termination runWithBudget", () => {
	it("reports completion when op resolves inside the budget", async () => {
		const completed = await runWithBudget(async () => {
			await new Promise((r) => setTimeout(r, 10));
		}, 200);
		strictEqual(completed, true);
	});

	it("reports timeout when op exceeds the budget", async () => {
		const start = Date.now();
		const completed = await runWithBudget(
			() =>
				new Promise<void>(() => {
					// never resolves
				}),
			80,
		);
		const elapsed = Date.now() - start;
		strictEqual(completed, false);
		// allow generous headroom for slow CI; the point is we didn't block indefinitely.
		ok(elapsed < 500, `expected prompt return, elapsed=${elapsed}ms`);
	});

	it("swallows rejections and routes them to onError", async () => {
		let captured: unknown = null;
		const completed = await runWithBudget(
			async () => {
				throw new Error("boom");
			},
			200,
			(err) => {
				captured = err;
			},
		);
		strictEqual(completed, true);
		ok(captured instanceof Error);
		strictEqual((captured as Error).message, "boom");
	});
});

describe("core/termination resolveShutdownHookBudgetMs", () => {
	it("returns the default when the env var is unset", () => {
		const saved = process.env.CLIO_SHUTDOWN_HOOK_MS;
		delete process.env.CLIO_SHUTDOWN_HOOK_MS;
		try {
			strictEqual(resolveShutdownHookBudgetMs(), DEFAULT_SHUTDOWN_HOOK_MS);
		} finally {
			if (saved !== undefined) process.env.CLIO_SHUTDOWN_HOOK_MS = saved;
		}
	});

	it("honors a positive integer override", () => {
		const saved = process.env.CLIO_SHUTDOWN_HOOK_MS;
		process.env.CLIO_SHUTDOWN_HOOK_MS = "123";
		try {
			strictEqual(resolveShutdownHookBudgetMs(), 123);
		} finally {
			if (saved === undefined) delete process.env.CLIO_SHUTDOWN_HOOK_MS;
			else process.env.CLIO_SHUTDOWN_HOOK_MS = saved;
		}
	});

	it("falls back to the default on garbage input", () => {
		const saved = process.env.CLIO_SHUTDOWN_HOOK_MS;
		process.env.CLIO_SHUTDOWN_HOOK_MS = "banana";
		try {
			strictEqual(resolveShutdownHookBudgetMs(), DEFAULT_SHUTDOWN_HOOK_MS);
		} finally {
			if (saved === undefined) delete process.env.CLIO_SHUTDOWN_HOOK_MS;
			else process.env.CLIO_SHUTDOWN_HOOK_MS = saved;
		}
	});
});

describe("core/domain-loader stop() timeout cap", () => {
	it("a hanging domain.stop() does not block the other domains", async () => {
		const saved = process.env.CLIO_SHUTDOWN_HOOK_MS;
		process.env.CLIO_SHUTDOWN_HOOK_MS = "80";
		const stopped: string[] = [];
		const modules: DomainModule[] = [
			makeDomain("fast-a", {
				stop: async () => {
					stopped.push("fast-a");
				},
			}),
			makeDomain("hanger", {
				stop: () =>
					new Promise<void>(() => {
						// intentionally never resolves
					}),
			}),
			makeDomain("fast-b", {
				stop: async () => {
					stopped.push("fast-b");
				},
			}),
		];
		try {
			const loaded = await loadDomains(modules);
			strictEqual(loaded.loaded.length, 3);
			const start = Date.now();
			await loaded.stop();
			const elapsed = Date.now() - start;
			ok(elapsed < 500, `shutdown should complete within a per-domain budget even when one hangs; elapsed=${elapsed}ms`);
			// Reverse-order teardown: fast-b runs before the hanger, fast-a after.
			strictEqual(stopped[0], "fast-b");
			strictEqual(stopped[1], "fast-a");
		} finally {
			if (saved === undefined) delete process.env.CLIO_SHUTDOWN_HOOK_MS;
			else process.env.CLIO_SHUTDOWN_HOOK_MS = saved;
		}
	});

	it("a throwing domain.stop() does not abort the rest of shutdown", async () => {
		const saved = process.env.CLIO_SHUTDOWN_HOOK_MS;
		process.env.CLIO_SHUTDOWN_HOOK_MS = "200";
		const stopped: string[] = [];
		const modules: DomainModule[] = [
			makeDomain("fast-a", {
				stop: async () => {
					stopped.push("fast-a");
				},
			}),
			makeDomain("thrower", {
				stop: async () => {
					throw new Error("stop failed");
				},
			}),
			makeDomain("fast-b", {
				stop: async () => {
					stopped.push("fast-b");
				},
			}),
		];
		try {
			const loaded = await loadDomains(modules);
			await loaded.stop();
			strictEqual(stopped.length, 2);
			ok(stopped.includes("fast-a"));
			ok(stopped.includes("fast-b"));
		} finally {
			if (saved === undefined) delete process.env.CLIO_SHUTDOWN_HOOK_MS;
			else process.env.CLIO_SHUTDOWN_HOOK_MS = saved;
		}
	});
});
