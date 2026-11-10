import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runFlywheelCommand } from "../../src/cli/flywheel.js";
import { runTelemetryShare } from "../../src/cli/telemetry-share.js";
import type { TelemetryContext } from "../../src/core/telemetry/context.js";
import {
	openShare,
	type ReportCommandRunner,
	readShareReceipts,
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

async function sealedSession(stateDir: string, sessionId: string): Promise<void> {
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
}

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
		await sealedSession(stateDir, sessionId);
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

test("telemetry share --send seals to the maintainers, posts the pointer discussion, and forget deletes the gist", async () => {
	const root = await mkdtemp(join(tmpdir(), "telemetry-share-send-"));
	try {
		const stateDir = join(root, "state");
		await sealedSession(stateDir, "ses_send");
		const gistId = "fedcba9876543210fedc";
		const calls: string[][] = [];
		let pointer = "";
		let category = true;
		let mutationFails = false;
		const run: ReportCommandRunner = async (_file, args) => {
			calls.push([...args]);
			const reply = (stdout: string) => ({ exitCode: 0, stdout, stderr: "", timedOut: false });
			if (args[0] === "auth") return reply("");
			if (args.includes("user")) return reply("octo\n");
			if (args.includes("POST") && args.includes("gists")) return reply(`${gistId}\n`);
			if (args.includes("DELETE")) return reply("");
			const query = args.find((arg) => arg.startsWith("query=")) ?? "";
			if (query.includes("discussionCategories")) return reply(category ? "R_1\tDIC_1\n" : "R_1\n");
			if (query.includes("createDiscussion")) {
				if (mutationFails) return { exitCode: 1, stdout: "", stderr: "HTTP 502", timedOut: false };
				pointer = readFileSync(args.find((arg) => arg.startsWith("body=@"))?.slice(6) ?? "", "utf8");
				return reply("https://github.com/iowarp/clio-coder/discussions/77\n");
			}
			return { exitCode: 1, stdout: "", stderr: "unexpected", timedOut: false };
		};
		let out = "";
		let err = "";
		let clock: Date | null = null;
		const share = (argv: string[], env: NodeJS.ProcessEnv = {}) =>
			runTelemetryShare(argv, {
				...(clock !== null ? { now: () => clock as Date } : {}),
				stateDir,
				env,
				interactive: false,
				findGh: () => "/usr/bin/gh",
				run,
				stdout: (text) => {
					out += text;
				},
				stderr: (text) => {
					err += text;
				},
			});
		const send = ["--session", "ses_send", "--send", "--consent", "debug"];

		strictEqual(await share(["--session", "ses_send", "--send"]), 2);
		ok(err.includes("--send needs --consent debug or --consent dataset"), err);
		strictEqual(await share([...send, "--out", join(root, "x.tar.gz")]), 2);
		strictEqual(await share([...send, "--profile", "report"]), 2);
		strictEqual(await share([...send, "--yes"], { AI_AGENT: "clio-coder" }), 2);
		ok(err.includes("an agent never shares telemetry"), err);
		strictEqual(await share(send), 2);
		ok(err.includes("pass --yes"), err);
		strictEqual(await share([...send, "--dry-run"]), 0);
		ok(out.includes("uploads it as a secret gist in your GitHub account") && out.includes("dry run: nothing sent"));
		category = false;
		strictEqual(await share([...send, "--yes"]), 1);
		ok(err.includes('"Telemetry shares" discussion category') && err.includes("nothing was uploaded"), err);
		ok(!calls.some((args) => args.includes("POST")), "a gist was created although the category is missing");
		category = true;

		mutationFails = true;
		strictEqual(await share([...send, "--yes"]), 1);
		ok(calls.some((args) => args.includes(`gists/${gistId}`) && args.includes("DELETE")));
		const failed = Object.values(readShareReceipts(stateDir));
		strictEqual(failed.length, 1);
		ok(failed[0]?.deletedAt !== null);
		mutationFails = false;

		out = "";
		strictEqual(await share(["--session", "ses_send", "--send", "--consent", "dataset", "--yes"]), 0);
		const shareId = /shared (shr_[0-9a-f]{16})/u.exec(out)?.[1] ?? "";
		match(
			pointer,
			new RegExp(
				`\`\`\`clio-coder-share\nv: 1\nshare: gist:${gistId}#${shareId}\nkind: telemetry-share\nversion: \\S+\nconsent: debug,dataset\nprofile: content-free\n\`\`\``,
				"u",
			),
		);
		ok(calls.some((args) => args.includes(`title=Telemetry share ${shareId}`)));
		const receipt = readShareReceipts(stateDir)[shareId];
		strictEqual(receipt?.url, "https://github.com/iowarp/clio-coder/discussions/77");
		strictEqual(receipt?.profile, "content-free");
		strictEqual(receipt?.consent, "debug,dataset");
		ok(!readdirSync(join(stateDir, "reports")).some((name) => name.endsWith(".md") || name.endsWith(".gist.json")));
		ok(!existsSync(join(root, "x.tar.gz")));

		out = "";
		strictEqual(await share(["list"]), 0);
		ok(out.includes(`${shareId}  telemetry-share`) && out.includes("live"), out);
		const before = calls.length;
		strictEqual(await share(["forget", shareId]), 0);
		ok(calls.slice(before).some((args) => args.includes("DELETE") && args.includes(`gists/${gistId}`)));
		ok(readShareReceipts(stateDir)[shareId]?.deletedAt !== null);
		strictEqual(await share(["forget", "shr_0000000000000000"]), 1);

		// No startup sweep: any later telemetry share run, even a local one, deletes a gist once it is 180 days old.
		out = "";
		strictEqual(await share([...send, "--yes"]), 0);
		const aging = /shared (shr_[0-9a-f]{16})/u.exec(out)?.[1] ?? "";
		ok(pointer.includes("once it is 180 days old, Clio Coder deletes it the next time the sender runs"), pointer);
		clock = new Date(Date.now() + 181 * 86_400_000);
		strictEqual(await share(["--session", "ses_send", "--out", join(root, "local.tar.gz")]), 0);
		ok(readShareReceipts(stateDir)[aging]?.deletedAt !== null);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("dev flywheel prints the ranked backlog and pulls a pointed-at share with the intake key", async () => {
	const root = await mkdtemp(join(tmpdir(), "flywheel-"));
	try {
		const csv = [
			"rank,kind,key,title,score,evidence,issue,firstSeen,lastSeen,versions",
			'1,failure,tool.bash.timeout,"bash times out, then retries",42.5,"7 shares, 3 versions",#512,2026-01-02,2026-02-01,0.7.0;0.7.1',
			"2,demand,feature.panes,split panes,9,4 requests,,2026-01-05,2026-01-30,0.7.1",
		].join("\n");
		const bundle = Buffer.from("not really a tar.gz, only bytes to carry");
		const shareId = "shr_00112233445566ff";
		const gistId = "abcdefabcdefabcdefab";
		const gone = "shr_ffeeddccbbaa9988";
		const envelope = sealShare(
			{
				...vector.plaintext,
				kind: "report-bundle",
				shareId,
				archiveFormat: "clio-coder.report.bundle",
				archive: bundle.toString("base64"),
			},
			{ recipient: { publicKey: vector.recipient.publicKey } },
		);
		const summary = {
			schemaVersion: 1,
			asOf: "2026-11-09",
			projects: {
				coder: {
					totals: { stars: 10, forks: 6 },
					trends: {
						"7d": {
							npmDownloads: { current: 841, previous: 757, changePct: 11.1 },
							installScriptRequests: { current: 147, previous: 0, changePct: null },
							githubViews: { current: 219, previous: 288, changePct: -24 },
							githubClones: { current: 2112, previous: 949, changePct: 122.6 },
						},
					},
					repos: {
						"iowarp/clio-coder": {
							stars: 10,
							forks: 6,
							latestRelease: "v0.7.0",
							latestReleaseDate: "2026-11-09",
							releaseAdoption: [
								{ version: "v0.7.0", downloadsTotal: 300, downloads7d: 30 },
								{ version: "v0.6.9", downloadsTotal: 100, downloads7d: 10 },
							],
						},
					},
					reports: { open: 2 },
					shares: { total: 3 },
					unknownSection: { later: true },
				},
			},
			sources: { npm: { status: "ok" }, gsc: { status: "error" } },
		};
		let access = true;
		const run: ReportCommandRunner = async (_file, args) => {
			const reply = (stdout: string) => ({ exitCode: 0, stdout, stderr: "", timedOut: false });
			const joined = args.join(" ");
			if (joined.includes("summary.json?ref=data")) return reply(JSON.stringify(summary));
			if (joined.includes("labels=digest"))
				return reply("41\tWeekly digest 2026-W45\thttps://github.com/iowarp/clio-metrics/issues/41\n");
			if (joined.includes("backlog.csv?ref=data"))
				return access ? reply(csv) : { exitCode: 1, stdout: "", stderr: "HTTP 404: Not Found", timedOut: false };
			if (joined.includes("labels=has-bundle"))
				return reply(`bundle: gist:${gistId}#${shareId}\nconsent: debug\nbundle: gist:${"1".repeat(20)}#${gone}\n`);
			if (joined.includes("discussions(first: 100")) return reply("");
			if (joined.includes(`gists/${gistId}`)) return reply(JSON.stringify(envelope));
			if (joined.includes(`gists/${"1".repeat(20)}`))
				return { exitCode: 1, stdout: "", stderr: "HTTP 404: Not Found", timedOut: false };
			return { exitCode: 1, stdout: "", stderr: `unexpected ${joined}`, timedOut: false };
		};
		let out = "";
		let err = "";
		const flywheel = (...argv: string[]) =>
			runFlywheelCommand(argv, {
				run,
				findGh: () => "/usr/bin/gh",
				env: {},
				cwd: root,
				stateDir: join(root, "state"),
				stdout: (text) => {
					out += text;
				},
				stderr: (text) => {
					err += text;
				},
			});

		strictEqual(await flywheel(), 0);
		ok(out.includes("bash times out, then retries") && out.includes("#512") && out.includes("split panes"), out);
		ok(out.indexOf("Usage, Clio Coder (7 days to 2026-11-09)") < out.indexOf("bash times out"), out);
		match(out, /npm downloads +841 \(\+11\.1%\)/u);
		match(out, /GitHub +219 \(-24\.0%\) views, 2112 \(\+122\.6%\) clones/u);
		match(out, /latest release +v0\.7\.0 \(2026-11-09\), 75% of release downloads \(7d\)/u);
		match(out, /open reports +2, shares on file 3/u);
		match(out, /stale sources +gsc \(error\)/u);
		ok(out.includes("#41 Weekly digest 2026-W45 https://github.com/iowarp/clio-metrics/issues/41"), out);
		out = "";
		strictEqual(await flywheel("--json", "--limit", "1"), 0);
		const parsed = JSON.parse(out) as { usage: Record<string, unknown>; backlog: Array<Record<string, unknown>> };
		deepStrictEqual(parsed.usage.npmDownloads7d, { current: 841, changePct: 11.1 });
		strictEqual(parsed.usage.installScriptRequests7d, 147);
		deepStrictEqual(parsed.usage.latestRelease, {
			version: "v0.7.0",
			date: "2026-11-09",
			adoption: { share: 0.75, window: "7d" },
		});
		strictEqual((parsed.usage.digest as { number: number }).number, 41);
		const rows = parsed.backlog;
		strictEqual(rows.length, 1);
		deepStrictEqual(
			{ rank: rows[0]?.rank, score: rows[0]?.score, evidence: rows[0]?.evidence, versions: rows[0]?.versions },
			{ rank: 1, score: 42.5, evidence: "7 shares, 3 versions", versions: "0.7.0;0.7.1" },
		);
		access = false;
		strictEqual(await flywheel(), 1);
		ok(err.includes("private to the Clio maintainers"), err);

		strictEqual(await flywheel("--pull", "nope"), 2);
		strictEqual(await flywheel("--pull", "all", "--key", join(root, "missing.pem")), 1);
		ok(err.includes("no intake key at"), err);
		const key = join(root, "intake.pem");
		writeFileSync(key, vector.recipient.privateKeyPem);
		out = "";
		strictEqual(await flywheel("--pull", "all", "--key", key, "--out", root), 0);
		deepStrictEqual(readFileSync(join(root, `${shareId}.tar.gz`)), bundle);
		ok(out.includes(`${gone}: gist`) && out.includes("its sender forgot it"), out);
		out = "";
		strictEqual(await flywheel("--pull", shareId, "--key", key, "--out", root), 0);
		ok(out.includes("report bundle already at"), out);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
