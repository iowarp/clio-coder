import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Value } from "typebox/value";
import { type ReportCliDeps, runReport } from "../../src/cli/report.js";
import { printReportBundle, runReportSelftest } from "../../src/cli/report-bundle.js";
import type { TelemetryContext } from "../../src/core/telemetry/context.js";
import type { JournalEventName } from "../../src/core/telemetry/events.js";
import { journalDefinition } from "../../src/core/telemetry/events.js";
import {
	buildBundle,
	type CanaryHit,
	canaryRefusal,
	canaryScan,
	composeReportDraft,
	issueCanaryHits,
	type LocalIdentity,
	outboxEntry,
	planReport,
	REPORT_BUNDLE_ENVELOPE_SCHEMA,
	type ReportBundleEnvelope,
	type ReportCommandRunner,
	type ReportDraft,
	readShareReceipts,
	reportBundlePath,
	reportMarkdownPath,
	routeFor,
	scrubText,
	sendReport,
	sweepReportBundles,
	updateOutbox,
} from "../../src/domains/report/index.js";
import { openCallJournal } from "../../src/domains/telemetry/call-journal.js";
import {
	telemetrySessionDirectory,
	unpackTelemetryArchive,
	verifyShareArchive,
} from "../../src/domains/telemetry/index.js";
import { PromptStructureObjectSchema } from "../../src/domains/telemetry/objects.js";
import {
	type Anonymize,
	createProjectionTally,
	type FieldProjection,
	type ProjectionTally,
	projectionFor,
	projectSharedObject,
	projectSharedPayload,
	SHARE_EVENT_PROJECTIONS,
	type ShareProjection,
} from "../../src/domains/telemetry/share-projection.js";
import { closedSchemaErrors } from "../../src/domains/telemetry/share-soundness.js";

// A machine whose every name is a canary: none of these may survive a projection, and the scan must find each.
const USER = "zqxuser";
const HOST = "zqxhost";
const PROJECT = "zqxproj";
const OWNER = "zqxowner";
const BRANCH = "zqxbranch";
const TARGET = "zqxtarget";
const CANARY_NAMES = [USER, HOST, PROJECT, OWNER, BRANCH, TARGET];
const IDENTITY: LocalIdentity = {
	packageRoot: null,
	paths: [`/home/${USER}`, `/home/${USER}/${PROJECT}`],
	remotes: [`git@github.com:${OWNER}/${PROJECT}.git`],
	names: [
		{ value: USER, kind: "user" },
		{ value: HOST, kind: "host" },
		{ value: PROJECT, kind: "project" },
		{ value: OWNER, kind: "remote" },
		{ value: BRANCH, kind: "branch" },
		{ value: TARGET, kind: "target" },
	],
};

const KEY = "canary-test-anonymization-key";
const anonymize: Anonymize = (kind, value) =>
	`anon_${createHmac("sha256", KEY).update(`${kind}\0${value}`).digest("hex").slice(0, 16)}`;

/**
 * Free text that names the whole machine: a user, a host, a workspace, a remote owner, a branch and a target, in the
 * shapes a log line or an error carries them. Numbered, so a survivor names the field it was planted in.
 */
let planted = 0;
const prose = () => `${USER}@${HOST}:/home/${USER}/${PROJECT} on ${BRANCH} via ${TARGET} for ${OWNER} #${++planted}`;

type Schema = Readonly<Record<string, unknown>>;
const asSchema = (value: unknown): Schema =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Schema) : {};

function admits(pattern: string, value: string): boolean {
	try {
		return new RegExp(pattern, "u").test(value);
	} catch {
		return new RegExp(pattern).test(value);
	}
}

/**
 * A free string's canary: prose by default, and where a closed pattern bounds the string, the first canary-bearing value
 * it admits (a bare name, names joined as an id), so a value that is bounded and still identifying is tried too.
 */
function canaryString(pattern: unknown, variant: number): string {
	if (typeof pattern !== "string") return prose();
	const name = CANARY_NAMES[variant % CANARY_NAMES.length] as string;
	const candidates = [prose(), name, `${name}-${PROJECT}`, `${name}_${HOST}`, `${name}.${HOST}`, `${name}:${PROJECT}`];
	return candidates.find((candidate) => admits(pattern, candidate)) ?? "x";
}

/** A payload for a schema with a canary in every free string and every free key; unions pick a branch by variant. */
function generate(schema: Schema, variant: number, depth = 0): unknown {
	if (depth > 8) return null;
	if (Array.isArray(schema.enum)) return schema.enum[variant % schema.enum.length];
	if (Object.hasOwn(schema, "const")) return schema.const;
	const union = schema.anyOf ?? schema.oneOf;
	if (Array.isArray(union) && union.length > 0)
		return generate(asSchema(union[(variant + depth) % union.length]), variant, depth + 1);
	if (Array.isArray(schema.allOf))
		return Object.assign({}, ...schema.allOf.map((branch) => generate(asSchema(branch), variant, depth + 1)));
	switch (schema.type) {
		case "string":
			return canaryString(schema.pattern, variant + depth);
		case "number":
		case "integer":
			return 1;
		case "boolean":
			return variant % 2 === 0;
		case "null":
			return null;
		case "array": {
			const tuple = Array.isArray(schema.items)
				? schema.items
				: Array.isArray(schema.prefixItems)
					? schema.prefixItems
					: null;
			if (tuple) return tuple.map((item) => generate(asSchema(item), variant, depth + 1));
			return [generate(asSchema(schema.items), variant, depth + 1)];
		}
		case "object": {
			const out: Record<string, unknown> = {};
			for (const [key, child] of Object.entries(asSchema(schema.properties)))
				out[key] = generate(asSchema(child), variant, depth + 1);
			for (const [pattern, child] of Object.entries(asSchema(schema.patternProperties)))
				out[canaryString(pattern, variant + depth)] = generate(asSchema(child), variant, depth + 1);
			if (schema.additionalProperties !== false && schema.patternProperties === undefined)
				out[canaryString(undefined, variant)] = generate(asSchema(schema.additionalProperties), variant, depth + 1);
			return out;
		}
		default:
			// An unconstrained value: free text or an object keyed by it.
			return variant % 2 === 0 ? prose() : { [prose()]: prose() };
	}
}

/** Every string and key in a projected value that still carries a canary name, with its path. */
function survivors(value: unknown, path = ""): Array<{ path: string; text: string }> {
	const carries = (text: string) => CANARY_NAMES.some((name) => text.toLowerCase().includes(name));
	if (typeof value === "string") return carries(value) ? [{ path, text: value }] : [];
	if (Array.isArray(value)) return value.flatMap((item, index) => survivors(item, `${path}[${index}]`));
	if (value !== null && typeof value === "object")
		return Object.entries(value).flatMap(([key, item]) => [
			...(carries(key) ? [{ path: `${path}.${key}`, text: key }] : []),
			...survivors(item, `${path}.${key}`),
		]);
	return [];
}

const readableValues = (tally: ProjectionTally) =>
	new Set([...tally.readable.values()].flatMap((values) => [...values]));

const PROJECTIONS: ReadonlyArray<{ label: string; projection: ShareProjection }> = [
	{ label: "content-free", projection: projectionFor("content-free") },
	{ label: "structural", projection: projectionFor("structural") },
	{ label: "report", projection: projectionFor("report") },
	{ label: "report --anonymize-models", projection: projectionFor("report", "anonymize") },
];
const VARIANTS = 12;
const EVENT_NAMES = Object.keys(SHARE_EVENT_PROJECTIONS) as JournalEventName[];

/** Project one event's generated payloads; a survivor is a leak unless the preview lists it as readable (R-16). */
function eventLeaks(name: string, projection: ShareProjection): string[] {
	const leaks: string[] = [];
	const schema = asSchema(journalDefinition(name as JournalEventName).schema);
	for (let variant = 0; variant < VARIANTS; variant++) {
		const tally = createProjectionTally();
		const projected = projectSharedPayload(name, generate(schema, variant), anonymize, projection, tally);
		const readable = readableValues(tally);
		for (const { path, text } of survivors(projected))
			if (!readable.has(text) || /[\s/@]/u.test(text)) leaks.push(`${name}${path}: ${JSON.stringify(text)}`);
	}
	return leaks;
}

test("a projected record still matches its event's schema under every report profile (R2b-report-03)", () => {
	const broken: string[] = [];
	for (const name of EVENT_NAMES) {
		const schema = journalDefinition(name).schema;
		for (const { label, projection } of PROJECTIONS.filter((entry) => entry.label.startsWith("report")))
			for (let variant = 0; variant < VARIANTS; variant++) {
				const payload = generate(asSchema(schema), variant);
				if (!Value.Check(schema, payload)) continue;
				const projected = projectSharedPayload(name, payload, anonymize, projection);
				if (!Value.Check(schema, projected)) broken.push(`${label}: ${name} variant ${variant}`);
			}
	}
	deepStrictEqual(broken, []);
	const hit = (path: string): CanaryHit => ({ member: "report.json", kind: "target", event: null, path });
	match(
		canaryRefusal([hit("environment.model")], undefined, { modelsKept: true }),
		/a model id contains this machine's target name, in report\.json\.environment\.model; build it again with --anonymize-models/u,
	);
	match(canaryRefusal([hit("environment.model")]), /This is a Clio Coder bug/u);
	match(
		canaryRefusal([hit("environment.model"), hit("environment.cwd")], undefined, { modelsKept: true }),
		/Clio Coder bug/u,
	);
});

test("no canary survives projection of any shareable event under any profile (R-19)", () => {
	let covered = 0;
	const leaks: string[] = [];
	for (const name of EVENT_NAMES) {
		covered += 1;
		for (const { label, projection } of PROJECTIONS)
			leaks.push(...eventLeaks(name, projection).map((leak) => `${label}: ${leak}`));
	}
	strictEqual(covered, Object.keys(SHARE_EVENT_PROJECTIONS).length);
	ok(covered > 50, `only ${covered} shareable events`);
	deepStrictEqual(leaks, []);
});

test("no canary survives projection of a structural object under any profile (R-19)", () => {
	const subjects: Record<string, (variant: number) => unknown> = {
		"prompt-structure": (variant) => generate(asSchema(PromptStructureObjectSchema), variant),
		"tool-schemas": () => ({
			name: `mcp__${OWNER}__${PROJECT}`,
			description: prose(),
			parameters: {
				type: "object",
				description: prose(),
				properties: {
					[`/home/${USER}/${PROJECT}`]: {
						type: "string",
						title: prose(),
						enum: [prose(), HOST],
						default: prose(),
						pattern: `^${USER}$`,
						examples: [prose()],
					},
					[BRANCH]: { type: TARGET, const: OWNER },
				},
				required: [`/home/${USER}/${PROJECT}`, BRANCH],
			},
		}),
		config: () => ({
			defaultTarget: TARGET,
			targets: [{ id: TARGET, url: `http://${HOST}.lab:8000/v1`, lmstudio: { models: { [`${USER}-finetune`]: {} } } }],
			workspace: `/home/${USER}/${PROJECT}`,
			[`${OWNER}-custom`]: prose(),
		}),
	};
	const leaks: string[] = [];
	for (const { label, projection } of PROJECTIONS)
		for (const [subject, make] of Object.entries(subjects))
			for (let variant = 0; variant < VARIANTS; variant++) {
				const tally = createProjectionTally();
				const projected = projectSharedObject(subject, make(variant), anonymize, projection, tally);
				ok(projected !== null, `${label} has no ${subject} projection`);
				const readable = readableValues(tally);
				for (const { path, text } of survivors(projected))
					if (!readable.has(text) || /[\s/@]/u.test(text))
						leaks.push(`${label}: ${subject}${path}: ${JSON.stringify(text)}`);
			}
	deepStrictEqual(leaks, []);
});

/** The first top-level field some event withholds: widening it to `keep` is the mistake both checks must catch. */
function widenOne(): { name: string; field: string; projection: ShareProjection } {
	const base = projectionFor("report");
	for (const name of EVENT_NAMES) {
		const table = base.events[name] as FieldProjection;
		if (typeof table !== "object") continue;
		const field = Object.keys(table).find((key) => table[key] === "withhold");
		if (field === undefined) continue;
		return {
			name,
			field,
			projection: { events: { ...base.events, [name]: { ...table, [field]: "keep" } }, objects: base.objects },
		};
	}
	throw new Error("no event withholds a top-level field");
}

test("a projection widened to keep a free string fails the canary test and the runtime scan (R-19)", () => {
	const { name, field, projection } = widenOne();
	strictEqual(eventLeaks(name, projectionFor("report")).length, 0);
	const leaks = eventLeaks(name, projection);
	ok(
		leaks.some((leak) => leak.startsWith(`${name}.${field}`)),
		`the widened ${name}.${field} leaked nothing: ${leaks.join("; ")}`,
	);

	const schema = asSchema(journalDefinition(name as JournalEventName).schema);
	const journal = (target: ShareProjection) =>
		Buffer.from(
			Array.from({ length: VARIANTS }, (_, variant) => {
				const data = projectSharedPayload(name, generate(schema, variant), anonymize, target);
				return `${JSON.stringify({ v: 1, k: name, data })}\t#00000000\n`;
			}).join(""),
		);
	const hits: CanaryHit[] = canaryScan([{ name: "journal.jsonl", bytes: journal(projection) }], IDENTITY);
	ok(
		hits.some((hit) => hit.event === name && hit.path?.startsWith(`data.${field}`)),
		`the scan missed ${name}.data.${field}: ${JSON.stringify(hits)}`,
	);
	for (const hit of hits) ok(!JSON.stringify(hit).includes(USER) && !JSON.stringify(hit).includes(HOST));
	deepStrictEqual(canaryScan([{ name: "journal.jsonl", bytes: journal(projectionFor("report")) }], IDENTITY), []);
});

test("the runtime scan finds escaped, cased and nested canaries and nothing in clean bytes (R-19)", () => {
	const escaped = Buffer.from(`{"note":"\\/home\\/${USER}\\/${PROJECT}\\/x"}`);
	const hits = canaryScan(
		[
			{ name: "report.json", bytes: Buffer.from(JSON.stringify({ env: { box: HOST.toUpperCase() } })) },
			{ name: "raw.txt", bytes: escaped },
			{ name: "clean.json", bytes: Buffer.from(JSON.stringify({ model: "qwen3.8-27b", user: "anon_0123456789abcdef" })) },
		],
		IDENTITY,
	);
	deepStrictEqual(
		hits.map(({ member, kind, path }) => ({ member, kind, path })),
		[
			{ member: "report.json", kind: "host", path: "env.box" },
			{ member: "raw.txt", kind: "path", path: "note" },
		],
	);
	// A location never repeats the value: a member name or key that is the identifier reads as its kind.
	deepStrictEqual(
		canaryScan(
			[{ name: `sessions/${USER}/a.json`, bytes: Buffer.from(JSON.stringify({ d: { [HOST]: 1 } })) }],
			IDENTITY,
		).map(({ member, kind, path }) => ({ member, kind, path })),
		[
			{ member: "sessions/<user>/a.json", kind: "user", path: null },
			{ member: "sessions/<user>/a.json", kind: "host", path: "d.<host>" },
		],
	);
	// A canary inside a longer word is not a hit: `zqxusers` is not the user `zqxuser`.
	deepStrictEqual(canaryScan([{ name: "a.json", bytes: Buffer.from(`["${USER}s"]`) }], IDENTITY), []);

	// An issue may carry what the reporter unmasked; the re-scrub removes exactly that, so only a scrubber miss blocks.
	const raw = `failed in /home/${USER}/${PROJECT} on ${HOST}`;
	const masks = scrubText(raw, IDENTITY).masks;
	const unmasked = masks.filter((mask) => mask.kind === "host").map((mask) => mask.id);
	const body = scrubText(raw, IDENTITY, unmasked).text;
	ok(body.includes(HOST));
	deepStrictEqual(issueCanaryHits({ title: "t", body }, IDENTITY), []);
});

test("a name beside `-` or `.` is masked on screen, and a miss is a review gate naming it, not a Send refusal (R2b-report-01)", async () => {
	const raw = `host ${USER}-laptop and ${HOST}.lan, see ${PROJECT}.config.ts and ${PROJECT}-api, the pre-${BRANCH} build`;
	const scrubbed = scrubText(raw, IDENTITY);
	strictEqual(
		scrubbed.text,
		"host <user>-laptop and <host>.lan, see <project>.config.ts and <project>-api, the pre-<branch> build",
	);
	deepStrictEqual(scrubbed.masks.map((mask) => mask.kind).sort(), ["branch", "host", "project", "user"]);
	deepStrictEqual(issueCanaryHits({ title: "t", body: scrubbed.text }, IDENTITY), []);
	// A name under the canary's minimum keeps the stricter boundaries.
	const short: LocalIdentity = { ...IDENTITY, names: [{ value: "zqx", kind: "project" }] };
	strictEqual(scrubText("zqx-api and zqx", short).text, "zqx-api and <project>");

	// A remote too short for the scrubber is still a canary: review names it and Send refuses without blaming Clio.
	const leaky: LocalIdentity = { ...IDENTITY, remotes: ["zq/abcd"] };
	const draft = composeReportDraft({
		kind: "bug",
		surface: "headless",
		title: "fix(report): the push step fails",
		happened: "The push to zq/abcd failed after the third retry with a timeout.",
	});
	const plan = planReport(draft, { identity: leaky, transport: { kind: "browser" } });
	const gate = 'The body still has this machine\'s remote "zq/abcd"; edit it out before sending.';
	ok(plan.gates.includes(gate), plan.gates.join("\n"));
	const stateDir = mkdtempSync(join(tmpdir(), "report-canary-gate-"));
	try {
		await rejects(
			sendReport(plan.rendered, routeFor("bug"), { kind: "browser" }, { kind: "create" }, { stateDir, identity: leaky }),
			{ message: `the report was not sent: ${gate}` },
		);
	} finally {
		rmSync(stateDir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------------------------------------------
// R-17: the report bundle, end to end over a live session

const WRITER = { clioCoderVersion: "0.7.1", piVersion: "0.0.0-test" };
const SECRET = ["AKIA", "ZQXABCDEFGHIJKLM"].join("");
const WORKSPACE_FILE = `/home/${USER}/${PROJECT}/src/app.ts`;

function message(turnId: string, parentTurnId: string | null, role: string, payload: unknown) {
	return { kind: "message", turnId, parentTurnId, timestamp: "2026-11-10T10:00:00.000Z", role, payload };
}

const LEDGER = [
	message("u1", null, "user", { text: "first turn" }),
	message("a1", "u1", "assistant", { content: [{ type: "text", text: "ok" }] }),
	message("u2", "a1", "user", { text: `Build fails in ${WORKSPACE_FILE} with key ${SECRET}` }),
	message("a2", "u2", "assistant", {
		content: [
			{ type: "thinking", thinking: "PRIVATE-REASONING", thinkingSignature: "SIG-1" },
			{ type: "text", text: `Reading ${WORKSPACE_FILE}`, textSignature: "SIG-2" },
			{ type: "toolCall", id: "call_1", name: "read", arguments: { path: WORKSPACE_FILE }, thoughtSignature: "SIG-3" },
		],
	}),
	message("r1", "a2", "tool_result", {
		toolCallId: "call_1",
		toolName: "read",
		result: { content: [{ type: "text", text: "TOOL-OUTPUT-MARKER" }] },
		isError: false,
	}),
	{ kind: "custom", customType: "test.note", turnId: "c1", parentTurnId: "r1", timestamp: "2026-11-10T10:00:01.000Z" },
];

/** A session as a running Clio leaves it: a flushed, unsealed telemetry journal and a ledger. */
async function liveSession(stateDir: string, sessionId: string): Promise<ReportDraft> {
	const context = { sessionId, agent: { role: "main", id: sessionId } } as TelemetryContext;
	const journal = await openCallJournal({
		directory: telemetrySessionDirectory(stateDir, sessionId),
		context,
		writer: WRITER,
	});
	for (const { kind, data } of [
		{ kind: "session.opened", data: {} },
		{
			kind: "turn.settled",
			data: { stopReason: "stop", terminal: { cause: null, stage: null, retries: 0, callIds: [] } },
		},
	])
		journal.enqueue({ kind, data, ctx: context, wallMs: Date.now(), mono: performance.now() } as Parameters<
			typeof journal.enqueue
		>[0]);
	await journal.flush();
	await journal.close();
	const ledger = join(stateDir, "sessions", "cwdhash0", sessionId);
	mkdirSync(ledger, { recursive: true });
	writeFileSync(join(ledger, "current.jsonl"), LEDGER.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
	return composeReportDraft({
		kind: "bug",
		surface: "headless",
		title: "Bundle contract test report",
		happened: "The bundle contract test composes this report over a live session.",
		session: { id: sessionId, observations: [] },
	});
}

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const member = (members: ReadonlyArray<{ path: string; bytes: Buffer }>, path: string) => {
	const found = members.find((entry) => entry.path === path);
	ok(found, `no ${path} member`);
	return found.bytes;
};

function cliIo(stateDir: string) {
	const out: string[] = [];
	const err: string[] = [];
	return {
		io: {
			out: (text: string) => void out.push(text),
			err: (text: string) => void err.push(text),
			stateDir,
			cwd: stateDir,
			identity: async () => IDENTITY,
		},
		out,
		err,
	};
}

test("a bundle of a live session is an envelope and a verified share archive, recorded by hash (R-17)", async () => {
	const root = mkdtempSync(join(tmpdir(), "report-bundle-"));
	try {
		const stateDir = join(root, "state");
		const draft = await liveSession(stateDir, "ses_bundle");
		const built = await buildBundle(draft, {
			consent: { scopes: ["debug"] },
			identity: IDENTITY,
			stateDir,
			writer: WRITER,
		});
		ok(built.path);
		const file = readFileSync(built.path);
		strictEqual(statSync(built.path).mode & 0o777, 0o600);
		const members = unpackTelemetryArchive(file);
		deepStrictEqual(
			members.map((entry) => entry.path),
			["report.json", "telemetry.tar.gz"],
		);
		const telemetry = member(members, "telemetry.tar.gz");
		strictEqual(verifyShareArchive(telemetry).failure, null);
		const envelope: unknown = JSON.parse(member(members, "report.json").toString("utf8"));
		ok(Value.Check(REPORT_BUNDLE_ENVELOPE_SCHEMA, envelope), "the envelope does not match its schema");
		deepStrictEqual(closedSchemaErrors(REPORT_BUNDLE_ENVELOPE_SCHEMA, "report.json"), []);
		const { consent, selection, telemetrySha256, transcriptSha256 } = envelope as ReportBundleEnvelope;
		strictEqual(telemetrySha256, sha(telemetry));
		strictEqual(transcriptSha256, null);
		deepStrictEqual(consent.scopes, ["debug"]);
		strictEqual(consent.content, "none");
		deepStrictEqual(selection, { sessions: ["ses_bundle"], runs: [], process: null, snapshot: "live" });

		// Independently of the scan: no canary in any byte, outer or inner.
		const inner = unpackTelemetryArchive(telemetry).map((entry) => entry.bytes.toString("utf8"));
		const text = [member(members, "report.json").toString("utf8"), ...inner].join("\n").toLowerCase();
		for (const name of CANARY_NAMES) ok(!text.includes(name), `${name} is in the bundle`);

		// What the preview and `report show --bundle` print is the file whose hash the outbox holds.
		const recorded = outboxEntry(stateDir, draft.id)?.bundle;
		deepStrictEqual(recorded, { sha256: sha(file), scopes: ["debug"], content: "none" });
		const shown = cliIo(stateDir);
		strictEqual(printReportBundle(shown.io, draft.id), 0);
		const printed = shown.out.join("");
		ok(printed.startsWith(`bundle sha256 ${sha(file)}, ${file.length} bytes\n`));
		ok(printed.includes("==> report.json <==") && printed.includes("==> telemetry.tar.gz/manifest.json <=="));
		writeFileSync(built.path, Buffer.concat([file, Buffer.from("x")]));
		strictEqual(printReportBundle(cliIo(stateDir).io, draft.id), 1);

		// Thirty days after sending, the bundle leaves the reports directory.
		updateOutbox(stateDir, draft.id, {
			kind: draft.kind,
			title: draft.title,
			state: "sent",
			sentAt: "2026-01-01T00:00:00.000Z",
		});
		deepStrictEqual(sweepReportBundles(stateDir, new Date("2026-01-31T00:00:01.000Z")), [draft.id]);
		ok(!existsSync(built.path));
		strictEqual(outboxEntry(stateDir, draft.id)?.bundle, null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the transcript tick adds an excerpt with thinking and signatures gone and planted values masked (R-17)", async () => {
	const root = mkdtempSync(join(tmpdir(), "report-bundle-transcript-"));
	try {
		const stateDir = join(root, "state");
		const draft = await liveSession(stateDir, "ses_transcript");
		const built = await buildBundle(draft, {
			consent: { scopes: ["debug", "dataset"] },
			transcript: { turns: 1 },
			identity: IDENTITY,
			stateDir,
			writer: WRITER,
		});
		const members = unpackTelemetryArchive(readFileSync(built.path ?? ""));
		deepStrictEqual(
			members.map((entry) => entry.path),
			["report.json", "telemetry.tar.gz", "transcript.jsonl"],
		);
		const transcript = member(members, "transcript.jsonl");
		strictEqual(built.envelope.transcriptSha256, sha(transcript));
		strictEqual(built.envelope.consent.content, "transcript");
		const text = transcript.toString("utf8");
		for (const absent of ["PRIVATE-REASONING", "Signature", "SIG-", SECRET, USER, PROJECT, "TOOL-OUTPUT-MARKER"])
			ok(!text.includes(absent), `${absent} is in the transcript`);
		for (const present of [
			"[redacted:aws-access-key]",
			"<path>",
			'"type":"omitted","part":"thinking"',
			'"name":"read","arguments":"[omitted: tool arguments]"',
			'"result":"[omitted: tool output]"',
			'{"omitted":"earlier entries","count":2}',
			'{"omitted":"custom"}',
			'"turns":1,"of":2,"toolOutput":false',
		])
			ok(text.includes(present), `${present} is missing from the transcript:\n${text}`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a canary in a member, or no consent, builds no bundle; selftest says which (R-17, R-19)", async () => {
	const root = mkdtempSync(join(tmpdir(), "report-bundle-refused-"));
	try {
		// The session is named for the user, so the name reaches the envelope and the share's member paths.
		const stateDir = join(root, "state");
		const draft = await liveSession(stateDir, USER);
		await rejects(
			buildBundle(draft, { consent: { scopes: ["debug"] }, identity: IDENTITY, stateDir, writer: WRITER }),
			(error: Error) => /: a user appears in /u.test(error.message) && !error.message.includes(USER),
		);
		ok(!existsSync(reportBundlePath(stateDir, draft.id)));
		strictEqual(outboxEntry(stateDir, draft.id), null);
		const refused = cliIo(stateDir);
		strictEqual(await runReportSelftest(refused.io, { session: USER, request: null }), 1);
		ok(refused.err.join("").includes("a user appears in"));

		await rejects(
			// @ts-expect-error consent is required on every call
			buildBundle(draft, { identity: IDENTITY, stateDir }),
			/no consent scope was given/,
		);
		await rejects(
			// @ts-expect-error an empty consent is no consent
			buildBundle(draft, { consent: { scopes: [] }, identity: IDENTITY, stateDir }),
			/no consent scope was given/,
		);

		const clean = join(root, "clean");
		await liveSession(clean, "ses_clean");
		const passed = cliIo(clean);
		strictEqual(await runReportSelftest(passed.io, { session: "ses_clean", request: null }), 0);
		match(
			passed.out.join(""),
			/^0 identifiers found in \d+ bytes \(report\.json, telemetry\.tar\.gz; \d+ telemetry records\)\n$/u,
		);
		ok(!existsSync(join(clean, "reports", "bundles")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("report --bundle mechanics shows its consent text, keeps the bundle only on send, and forget deletes it (R-17, R2b-report-02)", async () => {
	const root = mkdtempSync(join(tmpdir(), "report-bundle-cli-"));
	try {
		const stateDir = join(root, "state");
		await liveSession(stateDir, "ses_cli");
		const bodyFile = join(root, "body.md");
		writeFileSync(bodyFile, "The footer flickered on every keystroke while a long turn streamed tool output.");
		let out = "";
		let err = "";
		const run: ReportCommandRunner = async (file, args) => {
			const reply = (stdout: string) => ({ exitCode: 0, stdout, stderr: "", timedOut: false });
			if (file === "git") return { exitCode: 1, stdout: "", stderr: "not a repository", timedOut: false };
			if (args[0] === "auth") return reply("");
			if (args.includes("user")) return reply("octo\n");
			if (args.includes("search/issues")) return reply("[]");
			if (args.some((arg) => arg.endsWith("releases/latest"))) return reply("v0.0.1\n");
			if (args[0] === "issue" && args[1] === "create") return reply("https://github.com/iowarp/clio-coder/issues/452\n");
			return { exitCode: 1, stdout: "", stderr: "unexpected", timedOut: false };
		};
		const deps: ReportCliDeps = {
			run,
			findGh: () => "/usr/bin/gh",
			browserAvailable: () => false,
			env: {},
			interactive: false,
			stdout: (text) => {
				out += text;
			},
			stderr: (text) => {
				err += text;
			},
			cwd: root,
			stateDir,
			identitySettings: {},
			changelog: null,
		};
		const report = (...extra: string[]) =>
			runReport(["bug", "--title", "fix: x fails on y", "--body-file", bodyFile, "--session", "ses_cli", ...extra], deps);
		const idIn = (text: string) => /bundles\/(rpt_[0-9A-Z]{26})\.tar\.gz/u.exec(text)?.[1] ?? "";

		// No silent default: a kept bundle records consent, so the scope is the reporter's to name.
		strictEqual(await report("--bundle", "mechanics", "--dry-run"), 2);
		ok(err.includes("--bundle mechanics needs --consent debug"), err);
		strictEqual(await report("--bundle", "mechanics", "--consent", "debug", "--transcript", "--dry-run"), 0);
		ok(out.includes("Transcript: the last 2 of 2 turns, tool arguments and output left out"), out);
		ok(out.includes("By sending the bundle you agree to:\n  The maintainers of Clio Coder may read this bundle"), out);
		ok(
			out.includes("  The bundle includes the last turns of this conversation") && !out.includes("cannot be recalled"),
			out,
		);
		ok(
			out.includes("Not saved: nothing was written.") && out.includes("The diagnostic bundle stays on this machine"),
			out,
		);
		ok(!existsSync(join(stateDir, "reports", "bundles")));

		out = "";
		strictEqual(await report("--bundle", "mechanics", "--consent", "dataset", "--yes"), 0);
		const sent = idIn(out);
		ok(out.includes("A published dataset cannot be recalled"), out);
		ok(out.includes("The diagnostic bundle stays on this machine; sending does not upload it."), out);
		const entry = outboxEntry(stateDir, sent);
		strictEqual(entry?.state, "sent");
		deepStrictEqual(entry?.bundle?.scopes, ["debug", "dataset"]);
		out = "";
		strictEqual(await runReport(["show", sent, "--bundle"], deps), 0);
		ok(out.startsWith(`${sent}  sent  `) && out.includes(`\nbundle sha256 ${entry?.bundle?.sha256}, `), out);
		// The body as sent is the file that went out, not the draft rendered again here (R2-safety-secrets-11).
		out = "";
		writeFileSync(reportMarkdownPath(stateDir, sent), "the body that went out\n");
		strictEqual(await runReport(["show", sent], deps), 0);
		ok(
			out.includes(`fix: x fails on y\n`) && out.includes("body as sent") && out.includes("the body that went out\n"),
			out,
		);

		// Refused for want of --yes: nothing is kept, so no bundle or outbox row is left without its draft.
		out = "";
		strictEqual(await report("--bundle", "mechanics", "--consent", "debug"), 2);
		const draft = idIn(out);
		ok(!existsSync(reportBundlePath(stateDir, draft)) && outboxEntry(stateDir, draft) === null);

		// forget deletes the local bundle of a sent report, as the consent text and help promise; the issue stays.
		out = "";
		ok(existsSync(reportBundlePath(stateDir, sent)));
		strictEqual(await runReport(["forget", sent], deps), 0);
		ok(!existsSync(reportBundlePath(stateDir, sent)) && out.includes("Clio cannot withdraw it"), out);
		strictEqual(outboxEntry(stateDir, sent)?.state, "sent");
		strictEqual(await runReport(["forget", sent], deps), 1);

		err = "";
		strictEqual(
			await runReport(["bug", "--body-file", bodyFile, "--bundle", "mechanics", "--consent", "debug"], deps),
			2,
		);
		ok(err.includes("--bundle mechanics bundles a session: pass --last or --session <id>"));
		strictEqual(await report("--transcript", "4"), 2);
		ok(err.includes("--transcript applies only with --bundle mechanics"));
		strictEqual(await runReport(["selftest", "--session", "ses_cli", "--transcript", "11"], deps), 2);
		ok(err.includes("--transcript takes 1 to 10 turns, not 11"));
		out = "";
		strictEqual(await runReport(["selftest", "--session", "ses_cli", "--anonymize-models"], deps), 0);
		match(out, /^0 identifiers found in \d+ bytes/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("report --share uploads the bundle sealed as a secret gist, names it in the block, and forget deletes it", async () => {
	const root = mkdtempSync(join(tmpdir(), "report-share-cli-"));
	try {
		const stateDir = join(root, "state");
		await liveSession(stateDir, "ses_share");
		const bodyFile = join(root, "body.md");
		writeFileSync(bodyFile, "The footer flickered on every keystroke while a long turn streamed tool output.");
		const gistId = "0123456789abcdef0123";
		type GistRequest = { description: string; public: boolean; files: Record<string, { content: string }> };
		const gists: GistRequest[] = [];
		let posted = "";
		const deleted: string[] = [];
		let gistFails = false;
		let postThrows = false;
		let openMatch = false;
		let commented = 0;
		const run: ReportCommandRunner = async (file, args) => {
			const reply = (stdout: string) => ({ exitCode: 0, stdout, stderr: "", timedOut: false });
			if (file === "git") return { exitCode: 1, stdout: "", stderr: "not a repository", timedOut: false };
			if (args[0] === "auth") return reply("");
			if (args.includes("user")) return reply("octo\n");
			if (args.includes("search/issues"))
				return reply(
					openMatch
						? JSON.stringify([
								{
									number: 600,
									title: "footer flickers while streaming tool output",
									state: "open",
									closed_at: null,
									updated_at: "2026-11-01T00:00:00Z",
									labels: [],
								},
							])
						: "[]",
				);
			if (args[0] === "issue" && args[1] === "comment") {
				commented++;
				return reply("https://github.com/iowarp/clio-coder/issues/600#issuecomment-1\n");
			}
			if (args.some((arg) => arg.endsWith("/reactions"))) return reply("{}");
			if (args.some((arg) => arg.endsWith("releases/latest"))) return reply("v0.0.1\n");
			if (args.includes("POST") && args.includes("gists")) {
				if (gistFails) return { exitCode: 1, stdout: "", stderr: "HTTP 403: missing scope", timedOut: false };
				gists.push(JSON.parse(readFileSync(args[args.indexOf("--input") + 1] ?? "", "utf8")));
				return reply(`${gistId}\n`);
			}
			if (args.includes("DELETE")) {
				deleted.push(args[args.length - 1] ?? "");
				return reply("");
			}
			if (args[0] === "issue" && args[1] === "create") {
				if (postThrows) throw new Error("gh was killed");
				posted = readFileSync(args[args.indexOf("--body-file") + 1] ?? "", "utf8");
				return reply("https://github.com/iowarp/clio-coder/issues/452\n");
			}
			return { exitCode: 1, stdout: "", stderr: "unexpected", timedOut: false };
		};
		let out = "";
		let err = "";
		const deps: ReportCliDeps = {
			run,
			findGh: () => "/usr/bin/gh",
			browserAvailable: () => false,
			env: {},
			interactive: false,
			stdout: (text) => {
				out += text;
			},
			stderr: (text) => {
				err += text;
			},
			cwd: root,
			stateDir,
			identitySettings: {},
			changelog: null,
		};
		const report = (...extra: string[]) =>
			runReport(
				["bug", "--title", "fix: x fails on y", "--body-file", bodyFile, "--session", "ses_share", ...extra],
				deps,
			);

		strictEqual(await report("--share", "--dry-run"), 2);
		ok(err.includes("--share shares the diagnostic bundle"), err);

		strictEqual(await report("--bundle", "mechanics", "--consent", "dataset", "--share", "--dry-run"), 0);
		match(out, /bundle: gist:<created on send>#shr_[0-9a-f]{16}\nconsent: debug,dataset\n/u);
		ok(out.includes("upload the bundle encrypted to the maintainers as a secret gist"), out);
		ok(out.includes("Once it is 180 days old, Clio Coder deletes it the next time you run"), out);
		strictEqual(gists.length, 0);

		gistFails = true;
		out = "";
		err = "";
		strictEqual(await report("--bundle", "mechanics", "--consent", "debug", "--share", "--yes"), 1);
		ok(err.includes("nothing was posted") && err.includes("gh auth refresh -s gist"), err);
		strictEqual(posted, "");

		gistFails = false;
		out = "";
		strictEqual(await report("--bundle", "mechanics", "--consent", "debug", "--share", "--yes"), 0);
		const shareId = /#(shr_[0-9a-f]{16})/u.exec(posted)?.[1] ?? "";
		ok(posted.includes(`bundle: gist:${gistId}#${shareId}\nconsent: debug\n`), posted);
		ok(!out.includes("The report now links"), out);
		strictEqual(gists.length, 1);
		const shared = gists[0] as GistRequest;
		strictEqual(shared.public, false);
		strictEqual(shared.description, `Clio Coder encrypted share ${shareId}`);
		const envelope = JSON.parse(shared.files[`clio-share-${shareId}.json`]?.content ?? "{}");
		strictEqual(envelope.format, "clio-coder.share.sealed");
		strictEqual(envelope.kid, "d7aad758f9cb9edc");
		strictEqual(envelope.shareId, shareId);
		strictEqual(envelope.kind, "report-bundle");
		ok(!JSON.stringify(envelope).includes("telemetry.tar.gz"));
		const sent = /bundles\/(rpt_[0-9A-Z]{26})\.tar\.gz/u.exec(out)?.[1] ?? "";
		deepStrictEqual(outboxEntry(stateDir, sent)?.share, { shareId, gistId });
		strictEqual(outboxEntry(stateDir, sent)?.consent, "debug");
		strictEqual(readShareReceipts(stateDir)[shareId]?.reportId, sent);
		ok(!existsSync(join(stateDir, "reports", `${shareId}.gist.json`)), "the gist request file was left behind");

		out = "";
		strictEqual(await runReport(["forget", sent], deps), 0);
		deepStrictEqual(deleted, [`gists/${gistId}`]);
		ok(out.includes(`deleted the encrypted share ${shareId}`), out);
		ok(readShareReceipts(stateDir)[shareId]?.deletedAt !== null);
		ok(!existsSync(reportBundlePath(stateDir, sent)));

		// The receipt is written before the post, so a post that dies still leaves the gist for forget and the sweep.
		postThrows = true;
		await report("--bundle", "mechanics", "--consent", "debug", "--share", "--yes").catch(() => 1);
		const live = Object.values(readShareReceipts(stateDir)).filter((receipt) => receipt.deletedAt === null);
		strictEqual(live.length, 1);
		strictEqual(live[0]?.gistId, gistId);
		strictEqual(live[0]?.kind, "report-bundle");
		deepStrictEqual(deleted, [`gists/${gistId}`]);

		// A comment on an existing issue is never scanned for shares, so nothing is uploaded for it.
		postThrows = false;
		openMatch = true;
		out = "";
		const before = gists.length;
		const flicker = ["bug", "--title", "footer flickers while streaming tool output", "--body-file", bodyFile];
		const shareFlags = ["--session", "ses_share", "--bundle", "mechanics", "--consent", "debug", "--share", "--yes"];
		strictEqual(await runReport([...flicker, ...shareFlags, "--on-duplicate", "comment"], deps), 0);
		strictEqual(commented, 1);
		strictEqual(gists.length, before);
		ok(out.includes("The bundle was not shared: a comment on an existing issue cannot carry it"), out);
		ok(!out.includes("Shared the bundle encrypted"), out);

		// A saved report's bundle is shared later by report send <id> --share, under the same rules.
		const saveDraft = async (...flags: string[]) => {
			out = "";
			strictEqual(await runReport([...flicker, "--yes", ...flags], deps), 3);
			return /saved as draft (rpt_[0-9A-Z]{26})/u.exec(out)?.[1] ?? "";
		};
		const bundleFlags = ["--session", "ses_share", "--bundle", "mechanics", "--consent", "debug"];
		const bare = await saveDraft();
		err = "";
		strictEqual(await runReport(["send", bare, "--share", "--yes"], deps), 2);
		ok(err.includes(`${bare} has no saved bundle to share`), err);
		const later = await saveDraft(...bundleFlags);
		ok(existsSync(reportBundlePath(stateDir, later)));
		out = "";
		err = "";
		strictEqual(await runReport(["send", later, "--share"], deps), 2);
		ok(out.includes("Sending also uploads the saved diagnostic bundle") && out.includes("you agree to:"), out);
		ok(err.includes("add --yes"), err);
		const session = { ...deps, interactive: true, env: { AI_AGENT: "clio-coder" } };
		strictEqual(await runReport(["send", later, "--share"], session), 2);
		ok(err.includes("an agent never shares a bundle"), err);
		strictEqual(gists.length, before);
		out = "";
		strictEqual(await runReport(["send", later, "--share", "--yes", "--on-duplicate", "comment"], deps), 0);
		strictEqual(gists.length, before);
		ok(out.includes("The bundle was not shared: a comment on an existing issue cannot carry it"), out);

		const filed = await saveDraft(...bundleFlags);
		posted = "";
		out = "";
		strictEqual(await runReport(["send", filed, "--share", "--yes", "--on-duplicate", "new"], deps), 0);
		strictEqual(gists.length, before + 1);
		const laterShare = /#(shr_[0-9a-f]{16})/u.exec(posted)?.[1] ?? "";
		ok(posted.includes(`bundle: gist:${gistId}#${laterShare}\nconsent: debug\n`), posted);
		deepStrictEqual(outboxEntry(stateDir, filed)?.share, { shareId: laterShare, gistId });
		strictEqual(readShareReceipts(stateDir)[laterShare]?.reportId, filed);
		ok(out.includes(`Shared the bundle encrypted as secret gist ${gistId} (${laterShare})`), out);

		// The receipt is written before the post here too.
		const dies = await saveDraft(...bundleFlags);
		postThrows = true;
		await runReport(["send", dies, "--share", "--yes", "--on-duplicate", "new"], deps).catch(() => 1);
		ok(
			Object.values(readShareReceipts(stateDir)).some(
				(receipt) => receipt.reportId === dies && receipt.deletedAt === null,
			),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
