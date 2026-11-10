import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import type { JournalEventName } from "../../src/core/telemetry/events.js";
import { journalDefinition } from "../../src/core/telemetry/events.js";
import {
	type CanaryHit,
	canaryScan,
	issueCanaryHits,
	type LocalIdentity,
	scrubText,
} from "../../src/domains/report/index.js";
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
