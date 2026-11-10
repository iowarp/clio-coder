import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { latestCrashSince, writeCrashRecord } from "../../src/domains/report/crash.js";
import {
	createOfferTriggers,
	emptyOfferLedger,
	OFFER_INTERVAL_MS,
	type OfferSession,
	offerRefusal,
	readOfferLedger,
	recordAnswer,
	recordSessionStart,
	takeHeadlessOffer,
} from "../../src/domains/report/offers.js";

const NOW = Date.parse("2026-03-10T12:00:00.000Z");
const FP = "fp-internal";

function session(overrides: Partial<OfferSession> = {}): OfferSession {
	return {
		id: "s2",
		offers: "ask",
		ledger: emptyOfferLedger(),
		turnRunning: false,
		attended: true,
		firstSession: false,
		...overrides,
	};
}

test("the host budget refuses an offer by each rule, in order", () => {
	strictEqual(offerRefusal({ fingerprint: FP }, NOW, session()), null);
	strictEqual(offerRefusal({ fingerprint: FP }, NOW, session({ offers: "off" })), "setting-off");
	strictEqual(offerRefusal({ fingerprint: FP }, NOW, session({ firstSession: true })), "first-session");
	const offeredHere = { ...emptyOfferLedger(), lastOfferAt: new Date(NOW - 1000).toISOString(), lastOfferSession: "s2" };
	strictEqual(offerRefusal({ fingerprint: FP }, NOW, session({ ledger: offeredHere })), "offered-this-session");
	const sixDays = { ...emptyOfferLedger(), lastOfferAt: new Date(NOW - OFFER_INTERVAL_MS + 60_000).toISOString() };
	strictEqual(offerRefusal({ fingerprint: FP }, NOW, session({ ledger: sixDays })), "within-seven-days");
	const eightDays = { ...emptyOfferLedger(), lastOfferAt: new Date(NOW - OFFER_INTERVAL_MS - 60_000).toISOString() };
	strictEqual(offerRefusal({ fingerprint: FP }, NOW, session({ ledger: eightDays })), null);
	const declined = { ...emptyOfferLedger(), declined: { [FP]: new Date(NOW).toISOString() } };
	strictEqual(offerRefusal({ fingerprint: FP }, NOW, session({ ledger: declined })), "declined");
	strictEqual(offerRefusal({ fingerprint: FP }, NOW, session({ turnRunning: true })), "turn-running");
	strictEqual(offerRefusal({ fingerprint: FP }, NOW, session({ attended: false })), "away");
});

test("a decline is kept per fingerprint, and never also turns the setting off", () => {
	const stateDir = mkdtempSync(join(tmpdir(), "report-offers-"));
	strictEqual(recordSessionStart(stateDir, new Date(NOW)).firstSession, true);
	strictEqual(recordSessionStart(stateDir, new Date(NOW + 1)).firstSession, false);
	recordAnswer(stateDir, FP, "declined", { now: new Date(NOW) });
	ok(Object.hasOwn(readOfferLedger(stateDir).declined, FP));
	let off = 0;
	recordAnswer(stateDir, "fp-other", "never", { writeOffersOff: () => off++ });
	strictEqual(off, 1);
});

test("an internal turn qualifies once; provider and rate-limit causes never do", () => {
	const triggers = createOfferTriggers("0.7.1");
	strictEqual(triggers.turnSettled("internal")?.trigger, "internal");
	strictEqual(triggers.turnSettled("internal"), null);
	for (let i = 0; i < 4; i++) {
		strictEqual(triggers.turnSettled("provider_5xx"), null);
		strictEqual(triggers.turnSettled("rate_limited"), null);
	}
	strictEqual(triggers.turnSettled(null), null);
	strictEqual(triggers.compactionSettled("failed"), null);
	strictEqual(triggers.compactionSettled("failed"), null);
	strictEqual(triggers.compactionSettled("committed"), null);
	strictEqual(triggers.compactionSettled("failed"), null);
	strictEqual(triggers.compactionSettled("failed"), null);
	strictEqual(triggers.compactionSettled("failed")?.cause, "compaction_paused");
});

test("a crash record keeps no absolute path and never throws on an unwritable state dir", () => {
	const stateDir = mkdtempSync(join(tmpdir(), "report-crash-"));
	const packageRoot = "/opt/clio-coder";
	const error = new TypeError("boom");
	error.stack = [
		"TypeError: boom",
		`    at render (${packageRoot}/dist/interactive/chat.js:10:5)`,
		"    at Object.run (/home/someone/project/node_modules/some-lib/index.js:1:1)",
		"    at secret (/home/someone/private/tool.js:3:3)",
		"    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
	].join("\n");
	const written = writeCrashRecord(error, "tui", { stateDir, packageRoot, now: new Date(NOW) });
	ok(written !== null);
	const text = readFileSync(written, "utf8");
	ok(!text.includes("/home/someone") && !text.includes(packageRoot), text);
	const record = latestCrashSince(stateDir, NOW - 1);
	deepStrictEqual(
		record?.frames.map((frame) => frame.module),
		["dist/interactive/chat.js", "some-lib", "external", "node:internal/process/task_queues"],
	);

	const file = join(stateDir, "not-a-dir");
	writeFileSync(file, "");
	strictEqual(writeCrashRecord(error, "tui", { stateDir: file, packageRoot }), null);
});

test("a headless run prints the offer line at most once a week, and never in CI or json", () => {
	const stateDir = mkdtempSync(join(tmpdir(), "report-headless-"));
	const base = { stateDir, sessionId: "h1", offers: "ask" as const, mode: "text" as const, env: {}, now: new Date(NOW) };
	strictEqual(takeHeadlessOffer({ ...base, env: { CI: "true" } }), false);
	strictEqual(takeHeadlessOffer({ ...base, mode: "json" }), false);
	strictEqual(takeHeadlessOffer({ ...base, offers: "off" }), false);
	strictEqual(takeHeadlessOffer(base), true);
	strictEqual(takeHeadlessOffer({ ...base, now: new Date(NOW + 1000) }), false);
});
