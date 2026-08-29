/**
 * `clio-coder doctor` reported on the roots and the install metadata and then stopped,
 * so the two stores that hold everything a user would lose were unchecked.
 *
 * The failures these cover: `rm -rf $CLIO_CODER_STATE_DIR/sessions` left a green
 * report and exit 0 while `clio-coder resume` found nothing; a ledger with an
 * unparseable line was reported by no row at all, only by a warning on stderr
 * during some later command; and a credentials file this version cannot parse
 * printed `OK credentials 600` while every provider in it read as disconnected.
 */
import { match, ok, strictEqual } from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { initializeClioHome } from "../../src/core/init.js";
import { type DoctorFinding, runDoctor } from "../../src/domains/lifecycle/doctor.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function isRoot(): boolean {
	return process.getuid?.() === 0;
}

describe("contracts/doctor store honesty", { concurrency: false }, () => {
	let scratch: Awaited<ReturnType<typeof isolateClioEnv>>;

	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-doctor-stores-");
		initializeClioHome();
	});

	afterEach(() => {
		scratch.restore();
	});

	function rowFor(name: string): DoctorFinding {
		const finding = runDoctor().find((entry) => entry.name === name);
		ok(finding !== undefined, `expected a "${name}" row`);
		return finding;
	}

	function writeLedger(sessionId: string, lines: ReadonlyArray<string>): string {
		const dir = join(scratch.dir, "state", "sessions", "cwdhash", sessionId);
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "current.jsonl");
		writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
		return path;
	}

	const HEADER = '{"type":"session","version":3}';

	function assistantCacheLine(
		turnId: string,
		timestamp: string,
		backendVerdict: "hot" | "partial" | "cold" | "small",
		expectedColdReasons: string[] = [],
		parentTurnId: string | null = null,
	): string {
		return JSON.stringify({
			kind: "message",
			role: "assistant",
			turnId,
			parentTurnId,
			timestamp,
			payload: {
				text: "done",
				promptCache: { backendVerdict, expectedColdReasons },
			},
		});
	}

	it("calls a session store that was deleted under a recorded install a failure", () => {
		strictEqual(rowFor("session store").ok, true, "the store initializeClioHome created is healthy");

		rmSync(join(scratch.dir, "state", "sessions"), { recursive: true, force: true });

		const row = rowFor("session store");
		strictEqual(row.ok, false, "a store that no longer exists is not a healthy install");
		match(row.detail, /sessions missing \(run `clio-coder doctor --fix`\)/u);
	});

	it("names the ledger and the line a damaged transcript loses", () => {
		writeLedger("s-clean", [HEADER, '{"kind":"message","turnId":"t1"}']);
		const damaged = writeLedger("s-torn", [HEADER, '{"kind":"mess']);

		const row = rowFor("session store");
		strictEqual(row.ok, false, "a ledger the resume reader cannot fully parse is a failure");
		match(row.detail, /1 of 2 ledgers/u);
		ok(row.detail.includes(`${damaged}:2: invalid JSON skipped`), `expected path:line detail, got: ${row.detail}`);
		ok(!row.detail.includes("s-clean"), "the intact ledger is not named");
	});

	it("summarizes the latest session's verdicts and top expected reason", () => {
		writeLedger("older", [HEADER, assistantCacheLine("old", "2026-08-20T00:00:00.000Z", "small", ["dispatch"])]);
		writeLedger("latest", [
			HEADER,
			assistantCacheLine("hot", "2026-08-29T00:00:01.000Z", "hot"),
			assistantCacheLine("cold-one", "2026-08-29T00:00:02.000Z", "cold", ["residency"]),
			assistantCacheLine("cold-two", "2026-08-29T00:00:03.000Z", "cold", ["residency", "dispatch"]),
		]);

		const row = rowFor("cache telemetry");
		strictEqual(row.ok, true);
		strictEqual(row.level, undefined);
		match(row.detail, /^last session latest: hot 1 · partial 0 · cold 2 · small 0;/u);
		match(row.detail, /top expected reason residency \(2\)$/u);
	});

	it("counts incurred calls on sibling branches in the session summary", () => {
		writeLedger("branched", [
			HEADER,
			assistantCacheLine("root", "2026-08-29T00:00:01.000Z", "hot"),
			assistantCacheLine("kept", "2026-08-29T00:00:02.000Z", "cold", [], "root"),
			assistantCacheLine("sibling", "2026-08-29T00:00:03.000Z", "partial", [], "root"),
		]);

		const row = rowFor("cache telemetry");
		match(row.detail, /^last session branched: hot 1 · partial 1 · cold 1 · small 0;/u);
	});

	it("keeps missing cache telemetry informational instead of measuring zero calls", () => {
		writeLedger("without-cache", [
			HEADER,
			JSON.stringify({
				kind: "message",
				role: "assistant",
				turnId: "a1",
				parentTurnId: null,
				timestamp: "2026-08-29T00:00:00.000Z",
				payload: { text: "done" },
			}),
		]);

		const row = rowFor("cache telemetry");
		strictEqual(row.ok, true);
		strictEqual(row.level, "warn");
		strictEqual(row.detail, "last session without-cache: no prompt-cache telemetry recorded");
	});

	/**
	 * The damage that hits several ledgers at once hits them the same way, so the
	 * row carried one sentence three times and ran to 607 characters on a line it
	 * gets one of. The count and the files are what differ between them; the
	 * sentence is not.
	 */
	it("says a repeated damage message once, and names the files that carry it", () => {
		for (let i = 0; i < 6; i += 1) {
			writeLedger(`s-torn-${i}`, [HEADER, '{"kind":"mess']);
		}

		const row = rowFor("session store");
		strictEqual(row.ok, false);
		match(row.detail, /6 of 6 ledgers/u);
		strictEqual(
			row.detail.match(/invalid JSON skipped/gu)?.length,
			1,
			`one message, said once: ${row.detail.length} chars: ${row.detail}`,
		);
		strictEqual(row.detail.match(/s-torn-\d/gu)?.length, 2, "two files named, the rest counted");
		match(row.detail, /\+4 more/u);
	});

	it("keeps distinct damage messages apart, and still caps how many it names", () => {
		// Three different failures, so three different sentences to say.
		writeLedger("s-torn", [HEADER, '{"kind":"mess']);
		writeLedger("s-bad-a", [HEADER, "not json at all"]);
		writeLedger("s-bad-b", [HEADER, "{{{"]);

		const row = rowFor("session store");
		strictEqual(row.ok, false);
		match(row.detail, /3 of 3 ledgers/u);
		for (const name of ["s-torn", "s-bad-a", "s-bad-b"]) {
			ok(row.detail.includes(name), `${name} is named: ${row.detail}`);
		}
	});

	// Running as root defeats the mode, and the row would correctly report a
	// listable directory.
	it("reports a session directory it cannot list rather than counting zero ledgers", { skip: isRoot() }, () => {
		writeLedger("s-one", [HEADER]);
		const sealed = join(scratch.dir, "state", "sessions", "cwdhash");
		chmodSync(sealed, 0o000);
		try {
			const row = rowFor("session store");
			strictEqual(row.ok, false, "a store with a directory this process cannot open is not a healthy store");
			ok(row.detail.includes(`${sealed} could not be listed`), `expected the sealed directory named: ${row.detail}`);
		} finally {
			chmodSync(sealed, 0o700);
		}
	});

	it("fails the credentials row when the store cannot be parsed, not just when the mode is wrong", () => {
		const creds = join(scratch.dir, "config", "credentials.yaml");
		strictEqual(rowFor("credentials").detail, "600", "the shipped scaffold reports the mode alone");
		strictEqual(rowFor("credentials").ok, true);

		writeFileSync(creds, "version: 2\nentries:\n\tstray: tab\n", { encoding: "utf8", mode: 0o600 });

		const row = rowFor("credentials");
		strictEqual(row.ok, false, "a store this version cannot parse is not `OK credentials 600`");
		match(row.detail, /^600; /u, "the mode is still reported");
		match(row.detail, /not valid YAML/u, "the reason the store could not be read is appended");
	});

	// Running as root defeats the mode: the file stays readable.
	it("names a remedy for a credentials file it cannot read instead of a bare errno", { skip: isRoot() }, () => {
		const creds = join(scratch.dir, "config", "credentials.yaml");
		chmodSync(creds, 0o000);
		try {
			const row = rowFor("credentials");
			strictEqual(row.ok, false);
			ok(!row.detail.startsWith("Error:"), `a raw thrown error is not a row: ${row.detail}`);
			ok(row.detail.includes(creds), "the file that cannot be read is named");
			match(row.detail, /\(run `clio-coder doctor --fix`\)$/u, "the row names the command that repairs it");
		} finally {
			chmodSync(creds, 0o600);
		}
	});

	it("fails the credentials row when an entry is stored in a shape this version cannot read", () => {
		writeFileSync(
			join(scratch.dir, "config", "credentials.yaml"),
			["version: 2", "entries:", "  future:", "    type: passkey", "    handle: abc", ""].join("\n"),
			{ encoding: "utf8", mode: 0o600 },
		);

		const row = rowFor("credentials");
		strictEqual(row.ok, false);
		match(row.detail, /future/u, "the entry that would be lost is named");
	});
});
