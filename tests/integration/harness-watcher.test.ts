import { deepStrictEqual, ok } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { watchRepo } from "../../src/harness/watcher.js";

describe("watchRepo", () => {
	let repo: string;

	beforeEach(() => {
		repo = mkdtempSync(join(tmpdir(), "clio-watch-"));
		mkdirSync(join(repo, "src"), { recursive: true });
		mkdirSync(join(repo, "src", "tools"), { recursive: true });
	});
	afterEach(() => {
		rmSync(repo, { recursive: true, force: true });
	});

	it("emits a change event for a file under src/", async () => {
		const events: { path: string }[] = [];
		const handle = watchRepo(repo, (event) => events.push({ path: event.path }));
		try {
			await delay(50);
			writeFileSync(join(repo, "src", "tools", "foo.ts"), "export const x = 1;\n");
			await delay(200);
			ok(
				events.some((e) => e.path.endsWith("foo.ts")),
				`expected a foo.ts event, got ${JSON.stringify(events)}`,
			);
		} finally {
			handle.close();
		}
	});

	it("debounces rapid edits to the same path", async () => {
		const events: { path: string }[] = [];
		const handle = watchRepo(repo, (event) => events.push({ path: event.path }), { debounceMs: 100 });
		try {
			await delay(50);
			const target = join(repo, "src", "tools", "bar.ts");
			writeFileSync(target, "1");
			writeFileSync(target, "2");
			writeFileSync(target, "3");
			await delay(300);
			const barEvents = events.filter((e) => e.path.endsWith("bar.ts"));
			deepStrictEqual(barEvents.length, 1, `expected 1 debounced event, got ${barEvents.length}`);
		} finally {
			handle.close();
		}
	});

	it("ignores editor sidecar files", async () => {
		const events: { path: string }[] = [];
		const handle = watchRepo(repo, (event) => events.push({ path: event.path }));
		try {
			await delay(50);
			writeFileSync(join(repo, "src", "tools", ".swp"), "swap");
			writeFileSync(join(repo, "src", "tools", "baz.ts~"), "backup");
			await delay(200);
			ok(!events.some((e) => e.path.endsWith(".swp") || e.path.endsWith("~")));
		} finally {
			handle.close();
		}
	});
});
