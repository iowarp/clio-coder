/**
 * B3 contract: evidence bundles redact secret-shaped values at build time, on
 * every serialized surface (receipt, transcript, tool-event previews, audit
 * rows), count the redactions in the overview, and leave secret-free bundles
 * untouched (redactionCount 0, no redaction markers). Raw local session files
 * are out of scope by design; the bundle is the export boundary.
 */

import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { openLedger } from "../../src/domains/dispatch/state.js";
import { buildEvidence } from "../../src/domains/evidence/index.js";
import { createRedactionTally, redactSecretsText } from "../../src/domains/evidence/redact.js";
import { clearScratchClioHome, newScratchClioHome } from "../harness/scratch-env.js";

/** One representative value per redaction pattern class. */
const SECRETS: Record<string, string> = {
	pem: "-----BEGIN PRIVATE KEY-----\nMIIEvXFIXTUREbody\n-----END PRIVATE KEY-----",
	awsAccessKey: "AKIAIOSFODNN7EXAMPLE",
	githubToken: "ghp_abcdefghijklmnopqrstuvwxyz012345",
	skKey: "sk-proj-abcdefghijklmnopqrstuv",
	slackToken: "xoxb-123456789012-abcdefghijkl",
	googleApiKey: "AIzaSyA1234567890abcdefghijklmnopqrstu",
	jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcd1234",
	assignmentValue: "hunter2hunter2hunter2",
};

const SESSION_ID = "sessredact1";

async function sealRunWithSession(scratch: string, task: string): Promise<string> {
	const ledger = openLedger();
	const envelope = ledger.create({
		agentId: "coder",
		task,
		targetId: "mini",
		wireModelId: "test-model",
		runtimeId: "openai-completions",
		runtimeKind: "http",
		sessionId: SESSION_ID,
		cwd: "/tmp",
	});
	// Session ledger entry inside the run window carrying a secret in its
	// command and output (surfaces: transcript + tool-event previews).
	const sessionDir = join(scratch, "state", "sessions", "somecwdhash", SESSION_ID);
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		join(sessionDir, "current.jsonl"),
		`${JSON.stringify({
			kind: "bashExecution",
			turnId: "t1",
			parentTurnId: null,
			timestamp: new Date().toISOString(),
			command: `export API_KEY=${SECRETS.assignmentValue} && ./run.sh`,
			output: `token ${SECRETS.githubToken} aws ${SECRETS.awsAccessKey}`,
			exitCode: 0,
			cancelled: false,
			truncated: false,
		})}\n`,
		"utf8",
	);
	// Audit row directly linked by runId, carrying secrets in its payload.
	const auditDir = join(scratch, "state", "audit");
	mkdirSync(auditDir, { recursive: true });
	writeFileSync(
		join(auditDir, "2099-01-01.jsonl"),
		`${JSON.stringify({
			kind: "tool_call",
			ts: new Date().toISOString(),
			runId: envelope.id,
			tool: "bash",
			decision: "allowed",
			command: `curl -H "Authorization: Bearer ${SECRETS.jwt}" -d key=${SECRETS.googleApiKey}`,
		})}\n`,
		"utf8",
	);
	const endedAt = new Date(Date.now() + 1000).toISOString();
	ledger.update(envelope.id, {
		status: "completed",
		outcome: "succeeded",
		outcomeDetail: null,
		endedAt,
		exitCode: 0,
		tokenCount: 10,
		costUsd: 0,
	});
	ledger.recordReceipt(envelope.id, {
		verification: { state: "unverified", basis: "no-validation-tool" },
		quality: {
			version: 1,
			typedValidations: [],
			responseSchema: { sourceId: null, schemaDigest: null, runtimeEnforceable: false, enforcementPassed: null },
			resultContract: null,
		},
		costProvenance: "unknown",
		runId: envelope.id,
		agentId: "coder",
		task,
		targetId: "mini",
		wireModelId: "test-model",
		runtimeId: "openai-completions",
		runtimeKind: "http",
		outcome: "succeeded",
		startedAt: envelope.startedAt,
		endedAt,
		exitCode: 0,
		tokenCount: 10,
		costUsd: 0,
		compiledPromptHash: null,
		staticCompositionHash: null,
		clioVersion: "test",
		piMonoVersion: "test",
		platform: process.platform,
		nodeVersion: process.version,
		toolCalls: 1,
		toolStats: [{ tool: "bash", count: 1, ok: 1, errors: 0, blocked: 0, totalDurationMs: 5 }],
		sessionId: SESSION_ID,
	});
	await ledger.persist();
	return envelope.id;
}

function readBundleFiles(directory: string): Map<string, string> {
	const files = new Map<string, string>();
	for (const name of readdirSync(directory)) {
		files.set(name, readFileSync(join(directory, name), "utf8"));
	}
	return files;
}

describe("contracts/evidence-redaction (B3)", () => {
	const ORIGINAL_ENV = { ...process.env };
	let scratch: string;

	beforeEach(() => {
		scratch = newScratchClioHome("clio-evidence-redact-");
	});

	afterEach(() => {
		for (const k of Object.keys(process.env)) {
			if (!(k in ORIGINAL_ENV)) Reflect.deleteProperty(process.env, k);
		}
		for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
			if (v !== undefined) process.env[k] = v;
		}
		clearScratchClioHome(scratch);
	});

	it("redacts every pattern class as free text", () => {
		for (const [kind, secret] of Object.entries(SECRETS)) {
			const tally = createRedactionTally();
			const text = kind === "assignmentValue" ? `MY_API_KEY=${secret}` : `leaked value: ${secret}`;
			const redacted = redactSecretsText(text, tally);
			ok(!redacted.includes(secret), `${kind} value must be removed: ${redacted}`);
			ok(redacted.includes("[redacted:"), `${kind} leaves a marker: ${redacted}`);
			strictEqual(tally.count >= 1, true, kind);
		}
	});

	it("scrubs a planted bundle on every surface and counts redactions in the overview", async () => {
		const task = `deploy with ${SECRETS.skKey} and slack ${SECRETS.slackToken}\n${SECRETS.pem}`;
		const runId = await sealRunWithSession(scratch, task);
		const result = await buildEvidence({
			dataDir: join(scratch, "data"),
			stateDir: join(scratch, "state"),
			runId,
		});
		ok(result.overview.redactionCount !== undefined, "overview carries redactionCount");
		ok((result.overview.redactionCount ?? 0) > 0, `redactionCount > 0: ${result.overview.redactionCount}`);
		const files = readBundleFiles(result.directory);
		ok(files.size >= 10, `bundle files written: ${[...files.keys()].join(", ")}`);
		for (const [name, content] of files) {
			for (const [kind, secret] of Object.entries(SECRETS)) {
				// The PEM plant spans lines; JSON-serialized surfaces escape the
				// newlines, so check the distinctive body line instead.
				const needle = kind === "pem" ? "MIIEvXFIXTURE" : secret;
				ok(!content.includes(needle), `${name} must not contain the ${kind} value`);
			}
		}
		const transcript = files.get("transcript.md") ?? "";
		ok(transcript.includes("[redacted:"), "transcript carries redaction markers");
		const toolEvents = files.get("tool-events.jsonl") ?? "";
		ok(toolEvents.includes("[redacted:"), "tool-event previews carry redaction markers");
		const auditLinked = files.get("audit-linked.jsonl") ?? "";
		ok(auditLinked.includes("[redacted:"), "audit rows carry redaction markers");
		const receipt = files.get("receipt.json") ?? "";
		ok(receipt.includes("[redacted:"), "receipts carry redaction markers");
	});

	it("leaves a secret-free bundle untouched: redactionCount 0 and no markers", async () => {
		const runId = await sealRunWithSession(scratch, "run the test suite and report results");
		// Overwrite the planted session/audit fixtures with innocent content.
		const sessionPath = join(scratch, "state", "sessions", "somecwdhash", SESSION_ID, "current.jsonl");
		writeFileSync(
			sessionPath,
			`${JSON.stringify({
				kind: "bashExecution",
				turnId: "t1",
				parentTurnId: null,
				timestamp: new Date().toISOString(),
				command: "npm test",
				output: "42 passing",
				exitCode: 0,
				cancelled: false,
				truncated: false,
			})}\n`,
			"utf8",
		);
		writeFileSync(
			join(scratch, "state", "audit", "2099-01-01.jsonl"),
			`${JSON.stringify({
				kind: "tool_call",
				ts: new Date().toISOString(),
				runId,
				tool: "bash",
				decision: "allowed",
				command: "npm test",
			})}\n`,
			"utf8",
		);
		const result = await buildEvidence({
			dataDir: join(scratch, "data"),
			stateDir: join(scratch, "state"),
			runId,
		});
		strictEqual(result.overview.redactionCount, 0);
		for (const [name, content] of readBundleFiles(result.directory)) {
			ok(!content.includes("[redacted:"), `${name} must carry no redaction markers`);
		}
	});
});
