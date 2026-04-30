/**
 * Resume-picker enrichment integration. `listSessionsForCwd` walks every
 * session directory for the cwd and folds first-user-message preview,
 * message count, and last-activity timestamp into each `SessionMeta` so
 * the /resume overlay can render meaningful rows. This test drives a
 * real bundle, persists turns to disk, and asserts the enriched fields.
 */
import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import { listSessionsForCwd } from "../../src/domains/session/history.js";
import type { SessionContract } from "../../src/domains/session/index.js";

function stubContext(): DomainContext {
	return {
		bus: { emit: () => {}, on: () => () => {} } as unknown as DomainContext["bus"],
		getContract: () => undefined,
	};
}

const ORIGINAL_ENV = { ...process.env };

describe("listSessionsForCwd enriches metadata for the /resume picker", () => {
	let scratch: string;
	let bundle: ReturnType<typeof createSessionBundle>;
	let contract: SessionContract;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-list-sessions-"));
		process.env.CLIO_HOME = scratch;
		process.env.CLIO_DATA_DIR = join(scratch, "data");
		process.env.CLIO_CONFIG_DIR = join(scratch, "config");
		process.env.CLIO_CACHE_DIR = join(scratch, "cache");
		resetXdgCache();
		bundle = createSessionBundle(stubContext());
		contract = bundle.contract;
	});

	afterEach(async () => {
		try {
			await contract.close();
		} catch {
			// already closed
		}
		for (const k of Object.keys(process.env)) {
			if (!(k in ORIGINAL_ENV)) Reflect.deleteProperty(process.env, k);
		}
		for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
			if (v !== undefined) process.env[k] = v;
		}
		rmSync(scratch, { recursive: true, force: true });
		resetXdgCache();
	});

	it("captures the first user message, total message count, and last activity", async () => {
		contract.create({ cwd: scratch });
		const u1 = contract.append({
			parentId: null,
			kind: "user",
			payload: { text: "Investigate the credentials probe regression and propose a fix." },
		});
		const a1 = contract.append({ parentId: u1.id, kind: "assistant", payload: { text: "looking..." } });
		contract.append({ parentId: a1.id, kind: "user", payload: { text: "follow-up question" } });
		await contract.checkpoint("test");
		await contract.close();

		const listed = listSessionsForCwd(scratch);
		strictEqual(listed.length, 1);
		const meta = listed[0];
		ok(meta);
		strictEqual(meta.firstMessagePreview, "Investigate the credentials probe regression and propose a fix.");
		strictEqual(meta.messageCount, 2);
		ok(meta.lastActivityAt && meta.lastActivityAt >= meta.createdAt, "last-activity must not precede creation");
	});

	it("collapses whitespace and truncates very long previews", async () => {
		contract.create({ cwd: scratch });
		const long = `${"word ".repeat(200)}TRAILER`;
		contract.append({ parentId: null, kind: "user", payload: { text: long } });
		await contract.checkpoint("test");
		await contract.close();

		const listed = listSessionsForCwd(scratch);
		const meta = listed[0];
		ok(meta);
		ok(meta.firstMessagePreview, "expected a preview");
		ok(meta.firstMessagePreview && meta.firstMessagePreview.length <= 240, "preview must respect the cap");
		ok(meta.firstMessagePreview?.endsWith("…"), "long previews are ellipsis-tagged");
		ok(meta.firstMessagePreview && !/\s{2,}/.test(meta.firstMessagePreview), "whitespace must be collapsed");
	});

	it("sorts most recently active session first regardless of creation order", async () => {
		// First session: created earlier, no follow-up activity.
		const meta1 = contract.create({ cwd: scratch });
		const u1 = contract.append({ parentId: null, kind: "user", payload: { text: "older topic" } });
		contract.append({ parentId: u1.id, kind: "assistant", payload: { text: "ok" } });
		await contract.checkpoint("test");
		await contract.close();

		// Re-open the bundle and create a newer session whose activity timestamp
		// will be later than session 1's last entry.
		bundle = createSessionBundle(stubContext());
		contract = bundle.contract;
		await new Promise((r) => setTimeout(r, 5));
		contract.create({ cwd: scratch });
		contract.append({ parentId: null, kind: "user", payload: { text: "newer topic" } });
		await contract.checkpoint("test");
		await contract.close();

		const listed = listSessionsForCwd(scratch);
		strictEqual(listed.length, 2);
		ok(
			listed[0]?.firstMessagePreview === "newer topic",
			`expected newer topic first, got ${listed[0]?.firstMessagePreview}`,
		);
		ok(listed[1]?.id === meta1.id);
	});

	it("survives sessions with no entries", async () => {
		contract.create({ cwd: scratch });
		await contract.checkpoint("test");
		await contract.close();

		const listed = listSessionsForCwd(scratch);
		strictEqual(listed.length, 1);
		const meta = listed[0];
		ok(meta);
		strictEqual(meta.firstMessagePreview, undefined);
		ok(meta.messageCount === undefined || meta.messageCount === 0);
	});
});
