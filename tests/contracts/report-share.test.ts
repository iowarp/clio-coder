import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TelemetryContext } from "../../src/core/telemetry/context.js";
import {
	openShare,
	type SealedShare,
	type SharePlaintext,
	sealShare,
	telemetryShareDigest,
} from "../../src/domains/report/index.js";
import { openCallJournal } from "../../src/domains/telemetry/call-journal.js";
import { telemetrySessionDirectory } from "../../src/domains/telemetry/paths.js";
import { packShare, planShare, resolveShareScopes, telemetryShareSource } from "../../src/domains/telemetry/share.js";

const vector = JSON.parse(readFileSync(new URL("../fixtures/share-seal-vector.json", import.meta.url), "utf8")) as {
	recipient: { publicKey: string; kid: string; privateKeyPem: string };
	ephemeralPrivateKey: string;
	nonce: string;
	plaintext: SharePlaintext;
	envelope: SealedShare;
};

test("sealing the contract's test vector reproduces its envelope byte for byte, and it opens to the plaintext", () => {
	const sealed = sealShare(vector.plaintext, {
		recipient: { publicKey: vector.recipient.publicKey },
		ephemeralPrivateKey: Buffer.from(vector.ephemeralPrivateKey, "base64"),
		nonce: Buffer.from(vector.nonce, "base64"),
	});
	deepStrictEqual(sealed, vector.envelope);
	strictEqual(sealed.kid, vector.recipient.kid);
	deepStrictEqual(openShare(vector.envelope, vector.recipient.privateKeyPem), vector.plaintext);
});

test("a fresh seal opens with the recipient key and names only its key id, share id and kind", () => {
	const sealed = sealShare(vector.plaintext, { recipient: { publicKey: vector.recipient.publicKey } });
	deepStrictEqual(Object.keys(sealed).sort(), ["ct", "epk", "format", "kid", "kind", "nonce", "shareId", "v"]);
	ok(!JSON.stringify(sealed).includes(vector.plaintext.archive));
	deepStrictEqual(openShare(sealed, vector.recipient.privateKeyPem), vector.plaintext);
	// The shipped recipient is the maintainers' key, whose id the contract fixes.
	strictEqual(sealShare(vector.plaintext).kid, "d7aad758f9cb9edc");
});

test("an altered envelope does not open", () => {
	const pem = vector.recipient.privateKeyPem;
	const ct = Buffer.from(vector.envelope.ct, "base64");
	ct[0] = (ct[0] ?? 0) ^ 1;
	throws(() => openShare({ ...vector.envelope, ct: ct.toString("base64") }, pem), /does not authenticate/u);
	// The share id is authenticated: moving the ciphertext under another id fails.
	throws(() => openShare({ ...vector.envelope, shareId: "shr_ffffffffffffffff" }, pem), /does not authenticate/u);
	throws(() => openShare({ ...vector.envelope, kind: "report-bundle" }, pem), /another share/u);
	throws(() => openShare({ ...vector.envelope, kid: "0000000000000000" }, pem), /sealed to key/u);
	throws(() => openShare({ ...vector.envelope, v: 2 }, pem), /not a version 1/u);
});

test("the digest counts events and tools by closed names only, collapsing operator tools into other", async () => {
	const root = await mkdtemp(join(tmpdir(), "report-share-"));
	try {
		const stateDir = join(root, "operator");
		const sessionId = "ses_digest";
		const context: TelemetryContext = { sessionId, agent: { role: "main", id: sessionId } };
		const journal = await openCallJournal({
			directory: telemetrySessionDirectory(stateDir, sessionId),
			context,
			writer: { clioCoderVersion: "0.0.0-test", piVersion: "test" },
		});
		const records = [
			{ kind: "session.opened", data: {} },
			{ kind: "tool.settled", data: { tool: "read", outcome: "ok", durationMs: 3 } },
			{ kind: "tool.settled", data: { tool: "read", outcome: "blocked", durationMs: 0, blocked: "refused" } },
			{ kind: "tool.settled", data: { tool: "ledger_private_lookup", outcome: "error", durationMs: 1 } },
			{
				kind: "turn.settled",
				data: { stopReason: "stop", terminal: { cause: null, stage: null, retries: 0, callIds: [] } },
			},
		];
		for (const { kind, data } of records)
			journal.enqueue({ kind, data, ctx: context, wallMs: Date.now(), mono: performance.now() } as Parameters<
				typeof journal.enqueue
			>[0]);
		await journal.flush();
		ok(await journal.seal());
		await journal.close();
		const { scopes, skipped } = resolveShareScopes(stateDir, {
			sessions: [sessionId],
			runs: [],
			repo: null,
			since: null,
			until: null,
		});
		const source = telemetryShareSource(stateDir);
		const writer = { clioCoderVersion: "0.0.0-test", piVersion: "test" };
		const archive = packShare(planShare({ scopes, skipped, profile: "content-free", source, writer }));
		const digest = telemetryShareDigest(archive, { platform: "darwin", install: "npm", profile: "content-free" });
		strictEqual(digest.os, "macos");
		deepStrictEqual(digest.scopes, { session: 1, run: 0, process: 0 });
		deepStrictEqual(digest.tools, { read: { ok: 1, error: 0, denied: 1 }, other: { ok: 0, error: 1, denied: 0 } });
		strictEqual(digest.events["tool.settled"], 3);
		strictEqual(digest.events["turn.settled"], 1);
		ok(digest.records >= 5);
		ok(!JSON.stringify(digest).includes("ledger"));
		throws(() => telemetryShareDigest(Buffer.from("nope"), { platform: "linux", install: "npm", profile: "x" }));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
