import { strictEqual } from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TelemetryContext } from "../../src/core/telemetry/context.js";
import type { TelemetryRecord } from "../../src/core/telemetry/envelope.js";
import { makeTelemetryRecord } from "../../src/core/telemetry/envelope.js";
import { attachJournalRoute } from "../../src/core/telemetry/hub.js";
import type { PendingTelemetry } from "../../src/core/telemetry/producer.js";
import { createQuotaCache } from "../../src/domains/quota/cache.js";
import { journalPolledQuota } from "../../src/domains/quota/reading.js";
import { createQuotaService } from "../../src/domains/quota/service.js";
import type { QuotaProvider, UsageSnapshot } from "../../src/domains/quota/types.js";
import { openCallJournal } from "../../src/domains/telemetry/call-journal.js";
import { telemetryProcessDirectory, telemetrySessionDirectory } from "../../src/domains/telemetry/paths.js";
import { telemetryProcessId } from "../../src/domains/telemetry/process-journal.js";
import { createLiveTelemetryModel } from "../../src/domains/telemetry/telemetry-live.js";
import { telemetryCall } from "../harness/telemetry-view.js";

// Every quota.read the hub journals, per provider.
const journaled = new Map<string, number>();
attachJournalRoute({
	journal(name, payload) {
		if (name === "quota.read") {
			const provider = (payload as { provider: string }).provider;
			journaled.set(provider, (journaled.get(provider) ?? 0) + 1);
		}
		return true;
	},
	dropped() {},
});

function fakeProvider(id: string, state: { credential: boolean; status?: UsageSnapshot["status"] }) {
	let fetches = 0;
	const provider: QuotaProvider = {
		id,
		displayName: id,
		async detect() {
			return state.credential;
		},
		async fetch() {
			fetches += 1;
			const status = state.credential ? (state.status ?? "ok") : "no_credentials";
			return {
				providerId: id,
				displayName: id,
				status,
				windows: status === "ok" ? [{ key: "primary", label: "Primary", usedPct: 10, resetsAt: null }] : [],
				message: status === "ok" ? null : `${id} is ${status}`,
				fetchedAt: new Date().toISOString(),
			};
		},
	};
	return { provider, fetches: () => fetches };
}

test("repeated reads of a provider without a credential fetch and journal once, and a login is picked up (gui-quota-poll-loop)", async () => {
	const state = { credential: false };
	const fake = fakeProvider("loop-no-credential", state);
	const service = createQuotaService({ providers: [fake.provider], includeLocal: false });
	// The GUI re-read quota on every journal update; each read used to fetch and journal again.
	for (let read = 0; read < 25; read += 1) await service.read();
	strictEqual(fake.fetches(), 1);
	strictEqual(journaled.get("loop-no-credential"), 1);
	// A credential appearing (auth login, in this process or another) ends the hold on the next read.
	state.credential = true;
	const [after] = await service.read();
	strictEqual(fake.fetches(), 2);
	strictEqual(after?.status, "ok");
	strictEqual(journaled.get("loop-no-credential"), 2);
});

test("a failed read is held for the failure backoff, then asked again", async () => {
	let now = 1_000_000;
	const state = { credential: true, status: "error" as UsageSnapshot["status"] };
	const fake = fakeProvider("loop-error", state);
	const cache = createQuotaCache({ now: () => now });
	for (let read = 0; read < 10; read += 1) await cache.resolve(fake.provider);
	strictEqual(fake.fetches(), 1);
	now += 60_000;
	state.status = "ok";
	strictEqual((await cache.resolve(fake.provider)).status, "ok");
	strictEqual(fake.fetches(), 2);
});

test("a rate-limited read is held for its Retry-After when that outlasts the failure backoff (C-19)", async () => {
	let now = 1_000_000;
	let fetches = 0;
	const provider: QuotaProvider = {
		id: "loop-retry-after",
		displayName: "loop-retry-after",
		async detect() {
			return true;
		},
		async fetch() {
			fetches += 1;
			return {
				providerId: "loop-retry-after",
				displayName: "loop-retry-after",
				status: "error",
				windows: [],
				message: "HTTP 429",
				retryAfterSeconds: 600,
				fetchedAt: null,
			};
		},
	};
	const cache = createQuotaCache({ now: () => now });
	await cache.resolve(provider);
	now += 61_000;
	await cache.resolve(provider);
	strictEqual(fetches, 1, "a 600 s Retry-After must outlast the 60 s backoff");
	now += 540_000;
	await cache.resolve(provider);
	strictEqual(fetches, 2);
});

test("a fresh process serves the shared reading and hold of the same credential only; holds clamp, clears stick, text is redacted (C-19)", async () => {
	const sharedStatePath = join(mkdtempSync(join(tmpdir(), "clio-coder-quota-shared-")), "quota-cache.json");
	let now = 1_000_000;
	const as = (fake: ReturnType<typeof fakeProvider>, scope: string): QuotaProvider => ({
		...fake.provider,
		credentialScope: async () => scope,
	});
	const good = fakeProvider("shared-good", { credential: true });
	const limited = fakeProvider("shared-limited", { credential: true, status: "error" });
	const first = createQuotaCache({ now: () => now, sharedStatePath });
	await first.resolve(as(good, "acct-a"));
	await first.resolve(as(limited, "acct-a"));

	// Another process: a new cache over the same file, inside the TTL and the failure hold.
	const second = createQuotaCache({ now: () => now, sharedStatePath });
	strictEqual((await second.resolve(as(good, "acct-a"))).status, "ok");
	await second.resolve(as(limited, "acct-a"));
	strictEqual(good.fetches(), 1, "a fresh process must not re-poll a fresh shared reading");
	strictEqual(limited.fetches(), 1, "the shared hold covers a process that never polled");
	// Another login sharing the state directory gets neither the reading nor the hold.
	await second.resolve(as(good, "acct-b"));
	await second.resolve(as(limited, "acct-b"));
	strictEqual(good.fetches(), 2);
	strictEqual(limited.fetches(), 2);

	// A clear travels with the file: the first process still holds the old miss, and its next write must not revive it.
	now += 1;
	second.clear("shared-limited");
	now += 1;
	await first.resolve(as(fakeProvider("shared-other", { credential: true }), "acct-a"));
	await createQuotaCache({ now: () => now, sharedStatePath }).resolve(as(limited, "acct-a"));
	strictEqual(limited.fetches(), 3, "a cleared hold is never written back");

	// Stored text is redacted like the telemetry journal.
	const leaky: QuotaProvider = {
		id: "shared-leaky",
		displayName: "shared-leaky",
		credentialScope: async () => "acct-a",
		detect: async () => true,
		fetch: async () => ({
			providerId: "shared-leaky",
			displayName: "shared-leaky",
			status: "error",
			windows: [],
			message: "proxy https://quota-user:hunter2-secret@proxy.example/ refused",
			fetchedAt: null,
		}),
	};
	await first.resolve(leaky);
	strictEqual(readFileSync(sharedStatePath, "utf8").includes("hunter2-secret"), false);

	// A stored hold past the cap, or stamped ahead of the clock, never holds past the cap.
	const miss = (storedAtMs: number, holdMs: number) => ({
		answer: { providerId: "x", displayName: "x", status: "error", windows: [], message: "HTTP 429", fetchedAt: null },
		status: "error",
		storedAtMs,
		holdMs,
		scope: "acct-a",
	});
	writeFileSync(
		sharedStatePath,
		JSON.stringify({
			version: 2,
			entries: {},
			misses: { "shared-good": miss(now, 1e15), "shared-other": miss(now + 3_600_000, 60_000) },
			cleared: {},
		}),
	);
	const future = fakeProvider("shared-other", { credential: true });
	await createQuotaCache({ now: () => now, sharedStatePath }).resolve(as(future, "acct-a"));
	strictEqual(future.fetches(), 1, "a stamp ahead of the clock reads as expired");
	now += 24 * 60 * 60_000;
	await createQuotaCache({ now: () => now, sharedStatePath }).resolve(as(good, "acct-a"));
	strictEqual(good.fetches(), 3, "a stored hold is clamped to the 24 h cap");

	writeFileSync(sharedStatePath, "{not json");
	await createQuotaCache({ now: () => now, sharedStatePath }).resolve(as(good, "acct-a"));
	strictEqual(good.fetches(), 4, "a corrupt shared file reads as empty, which means poll");
});

test("an unchanged failed poll is journaled once, while each successful poll still marks freshness", () => {
	const snapshot = (status: UsageSnapshot["status"], provider: string): UsageSnapshot => ({
		providerId: provider,
		displayName: provider,
		status,
		windows: status === "ok" ? [{ key: "primary", label: "Primary", usedPct: 10, resetsAt: null }] : [],
		message: status === "ok" ? null : "no credential",
		fetchedAt: null,
	});
	const start = Date.parse("2026-11-08T00:00:00.000Z");
	for (let poll = 0; poll < 3; poll += 1)
		journalPolledQuota(snapshot("no_credentials", "fp-failed"), start + poll * 1000);
	strictEqual(journaled.get("fp-failed"), 1);
	for (let poll = 0; poll < 3; poll += 1) journalPolledQuota(snapshot("ok", "fp-ok"), start + poll * 1000);
	strictEqual(journaled.get("fp-ok"), 3);
});

test("a quota.read that repeats the account's newest failed reading moves no session topic", {
	timeout: 10_000,
}, async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "clio-coder-quota-loop-"));
	const sessionId = "quota-loop";
	const session = await openCallJournal({
		directory: telemetrySessionDirectory(stateDir, sessionId),
		context: { sessionId, agent: { role: "main", id: sessionId } },
		writer: { clioCoderVersion: "test", piVersion: "test" },
	});
	const processId = telemetryProcessId();
	const processContext: TelemetryContext = { sessionId: null, processId, agent: { role: "main", id: processId } };
	const processJournal = await openCallJournal({
		directory: telemetryProcessDirectory(stateDir, processId),
		context: processContext,
		writer: { clioCoderVersion: "test", piVersion: "test" },
	});
	const write = async (writer: typeof session, records: readonly TelemetryRecord[]) => {
		for (const record of records)
			writer.enqueue({
				kind: record.k,
				data: record.data,
				ctx: record.ctx,
				wallMs: Date.parse(record.t),
				mono: record.mono,
				recordId: record.id,
			} as PendingTelemetry);
		await writer.flush();
	};
	const reading = (at: string) =>
		makeTelemetryRecord(
			"quota.read",
			{
				provider: "codex",
				targetId: "codex",
				source: "poll",
				observedAt: at,
				windows: [],
				displayName: "OpenAI Codex",
				status: "no_credentials",
				message: "CLIO Coder holds no OpenAI Codex OAuth credential",
			},
			processContext,
			{ t: at, mono: 0 },
		);
	const settle = () => new Promise((resolve) => setTimeout(resolve, 400));
	await write(session, telemetryCall(sessionId));
	const model = createLiveTelemetryModel({ stateDir: () => stateDir });
	try {
		model.bind(sessionId);
		let sessionUpdates = 0;
		const seeded = new Promise<void>((resolve) =>
			model.subscribe("session", () => {
				sessionUpdates += 1;
				if (model.live()?.seeding === false) resolve();
			}),
		);
		model.live();
		await seeded;
		// A quota reader starts following this process's journal.
		model.quota("codex");
		await settle();
		const now = Date.now();
		await write(processJournal, [reading(new Date(now).toISOString())]);
		await settle();
		const afterFirst = sessionUpdates;
		strictEqual(afterFirst > 0, true, "the first reading reaches the session view");
		for (let poll = 1; poll <= 5; poll += 1) {
			await write(processJournal, [reading(new Date(now + poll * 117).toISOString())]);
			await settle();
		}
		strictEqual(sessionUpdates, afterFirst, "a repeated failed reading must not re-dirty the session");
	} finally {
		model.stop();
		await session.close();
		await processJournal.close();
	}
});
