import { deepStrictEqual, notDeepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Type } from "typebox";
import { codexAccountScope } from "../../src/core/codex-account.js";
import { type ProviderCheckpoint, prepareProviderCheckpoint } from "../../src/core/provider-checkpoint.js";
import type {
	AcceptedNote,
	ContinuityCheckpointPayload,
	HandoffEvent,
	HandoffIdentity,
	HandoffPolicy,
} from "../../src/domains/session/continuity/contract.js";
import { validateContinuityNote } from "../../src/domains/session/continuity/note.js";
import { resolveContinuityProjection } from "../../src/domains/session/continuity/projection.js";
import type { SessionEntryInput } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { engineStreamSimple } from "../../src/engine/api-registry.js";
import { engineModels } from "../../src/engine/models.js";
import { openSession } from "../../src/engine/session.js";
import type { EngineModel, ProviderCheckpointHandle } from "../../src/engine/types.js";
import type { ToolSpec } from "../../src/tools/registry.js";
import {
	CAPTURE_TARGET_B,
	type CapturedRequest,
	type CaptureServer,
	chatHarness,
	startCaptureServer,
	tapEngineApi,
	wireElements,
} from "../harness/context-capture.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

/**
 * ContextFold CF-0 pins. Each passes today and must keep passing through every CF lane. P3 is pinned where it already
 * lives (tests/extended/live-context-anchor.test.ts, the measured-anchor and stale-anchor cases); P4's raw child-file
 * exclusions stay in tests/contracts/continuity-replay-fork.test.ts and are extended here through the capture.
 */

let env: IsolatedClioEnv;
let previousCwd: string;
beforeEach(async () => {
	env = await isolateClioEnv("context-fold-pins-");
	previousCwd = process.cwd();
	const project = path.join(env.dir, "project");
	mkdirSync(project);
	process.chdir(project);
});
afterEach(() => {
	process.chdir(previousCwd);
	env.restore();
});

const lastUser = (request: CapturedRequest): string =>
	wireElements(request)
		.filter((element) => element.startsWith("user:"))
		.at(-1) ?? "";
const answered = (request: CapturedRequest): boolean => wireElements(request).at(-1)?.startsWith("result:") === true;
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe("adapter capture", () => {
	for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
		it(`${api}: the logical elements of one context agree with the session capture`, async () => {
			const server = await startCaptureServer(() => ({ text: "ok" }));
			const tap = tapEngineApi(api);
			const model = {
				api,
				provider: api === "anthropic-messages" ? "anthropic" : "openai",
				id: "capture-model",
				name: "capture-model",
				baseUrl: api === "anthropic-messages" ? server.url : `${server.url}/v1`,
				reasoning: false,
				input: ["text"],
				contextWindow: 32_000,
				maxTokens: 1_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			} as EngineModel;
			try {
				const reply = await engineStreamSimple(
					model,
					{
						systemPrompt: "Fixture system.",
						messages: [
							{ role: "user", content: "read a", timestamp: 1 },
							{
								role: "assistant",
								api,
								provider: model.provider,
								model: model.id,
								stopReason: "toolUse",
								timestamp: 2,
								usage: {
									input: 1,
									output: 1,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 2,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
								},
								content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a" } }],
							},
							{
								role: "toolResult",
								toolCallId: "call_1",
								toolName: "read",
								content: [{ type: "text", text: "body a" }],
								isError: false,
								timestamp: 3,
							},
						],
					},
					{ apiKey: "fixture", maxTokens: 100 },
				).result();
				strictEqual(reply.stopReason, "stop", reply.errorMessage);
				strictEqual(server.requests.length, 1);
				strictEqual(tap.contexts.length, 1, "the tap saw the one request");
				strictEqual(tap.contexts[0]?.systemPrompt, "Fixture system.");
				deepStrictEqual(
					tap.contexts[0]?.messages.map((message) => message.role),
					["user", "assistant", "toolResult"],
				);
				const [request] = server.requests;
				ok(request);
				strictEqual(request.family, api);
				deepStrictEqual(wireElements(request), [
					"system:Fixture system.",
					"user:read a",
					'call:read({"path":"a"})',
					"result:body a",
				]);
			} finally {
				tap.restore();
				await server.close();
			}
		});
	}
});

describe("P1: a text-only route with a historical image; a locked round then an unlocked one", () => {
	const IMAGE = "SENTINEL_IMAGE_BYTES";
	const OMITTED = "[Image omitted from this request: the current model does not accept image input.]";

	it("never sends the image bytes, keeps the omission note in place, and locks one round only", {
		timeout: 20_000,
	}, async () => {
		let harness: ReturnType<typeof chatHarness> | undefined;
		const locker: ToolSpec = {
			name: "probe" as ToolSpec["name"],
			description: "Repeats the same failing call until the loop guard locks the run",
			parameters: Type.Object({}),
			baseActionClass: "read",
			run: async () => {
				harness?.context.bus.emit("safety.loop_blocked", {
					disposition: "lockout",
					tool: "probe",
					priorFailure: "the same call failed again",
					repeatCount: 3,
					blocksThisTurn: 1,
					budget: 3,
					interrupted: false,
					at: Date.now(),
				});
				return { kind: "ok", output: "probe result" };
			},
		};
		const server = await startCaptureServer((request) =>
			lastUser(request) === "user:lock this round" && !answered(request)
				? { calls: [{ id: "call-probe", name: "probe", arguments: {} }] }
				: { text: "answered" },
		);
		harness = chatHarness({
			server,
			route: { caching: false, window: 64_000, image: true },
			routeB: { image: false },
			tools: [locker],
		});
		try {
			await harness.loop.submit("look at this", { images: [{ type: "image", mimeType: "image/png", data: IMAGE }] });
			await harness.loop.whenSettled();
			strictEqual(server.requests.length, 1);
			ok(JSON.stringify(server.requests[0]?.body).includes(IMAGE), "the vision route received the image");

			harness.settings.chat.target = CAPTURE_TARGET_B;
			await harness.submit("lock this round");
			await harness.submit("and continue");
			const textOnly = server.requests.slice(1);
			strictEqual(textOnly.length, 3, "an opening round, the locked round, and the next submit");
			const [opening, locked, unlocked] = textOnly;
			ok(opening && locked && unlocked);
			for (const request of textOnly) {
				ok(!JSON.stringify(request.body).includes(IMAGE), "the text-only route never receives image bytes");
				strictEqual(wireElements(request)[1], `user:look at this${OMITTED}`, "the omission note holds the image's place");
			}

			// The locked round: tools stay declared so the prefix holds, the choice is none, the directive rides the tail.
			strictEqual(locked.body.tool_choice, "none");
			deepStrictEqual(locked.body.tools, opening.body.tools);
			ok(wireElements(locked).at(-1)?.includes("Current execution phase: final synthesis"));
			// The next submit is unlocked: the same tools, no forced choice, and no directive anywhere.
			strictEqual(unlocked.body.tool_choice, undefined);
			deepStrictEqual(unlocked.body.tools, opening.body.tools);
			ok(!JSON.stringify(unlocked.body).includes("Current execution phase: final synthesis"));
			deepStrictEqual(
				wireElements(unlocked).slice(0, 2),
				wireElements(locked).slice(0, 2),
				"the historical image renders the same in both rounds",
			);
		} finally {
			await harness.close();
			await server.close();
		}
	});
});

const AT = "2026-09-21T09:00:00.000Z";
const PREPARED_AT = Date.parse(AT);

function admit(text: string): AcceptedNote {
	const result = validateContinuityNote(text);
	if (!result.ok) throw new Error(`fixture note rejected: ${result.reason}`);
	return result.accepted;
}
const NOTE = admit("A: finish the parser rewrite; the failing case is a nested fence");

function policy(): HandoffPolicy {
	return {
		preparedAtMs: PREPARED_AT,
		automaticDeadlineAtMs: PREPARED_AT + 600_000_000_000,
		maxAttempts: 2,
		maxSummaryCallsPerAttempt: 2,
		additionalSummaryRetriesPerCall: 0,
		maxSummaryStreamInvocations: 4,
		flushRetryLimit: 3,
	};
}

/** A ready handoff on the parent, anchored on m2, whose resume is still due: the parent may still execute it. */
function readyHandoff(sessionId: string): SessionEntryInput[] {
	const identity: HandoffIdentity = {
		handoffId: "a-h",
		preparedEntryId: "a-prep",
		commitId: "a-commit",
		commitEntryId: "a-commit-entry",
		originSessionId: sessionId,
		branchAnchorTurnId: "m2",
		initiatingTurnId: "m1",
		toolCallId: "a-tc",
		sourceRevision: "lb-1-00000000000000ff",
	};
	const tx = (entryId: string, prev: string | null, sequence: number, attempt: number, event: HandoffEvent) =>
		({
			kind: "handoffTransaction",
			turnId: entryId,
			parentTurnId: "m2",
			timestamp: AT,
			schemaVersion: 1,
			identity,
			transition: { entryId, prevEntryId: prev, sequence, attempt },
			event,
		}) as unknown as SessionEntryInput;
	const transition = { entryId: "a-commit-entry", prevEntryId: "a-reduce", sequence: 2, attempt: 1 };
	const payload = {
		schemaVersion: 1,
		identity,
		accepted: NOTE,
		policy: policy(),
		commit: {
			outcome: "summarized",
			entry: { turnId: "a-commit-entry", parentTurnId: "m2", timestamp: AT },
			transition,
			summaryRef: "a-summary",
			tokensBefore: 30_000,
			tokensAfter: 9_000,
		},
		state: { transition, event: { phase: "ready" }, activeResume: null, delivery: null },
	} as unknown as ContinuityCheckpointPayload;
	return [
		tx("a-prep", null, 0, 0, { phase: "prepared", accepted: NOTE, policy: policy() }),
		tx("a-reduce", "a-prep", 1, 1, { phase: "reducing" }),
		{
			kind: "compactionSummary",
			turnId: "a-summary",
			parentTurnId: "m2",
			timestamp: AT,
			summary: "earlier work summarized",
			tokensBefore: 30_000,
			firstKeptTurnId: "m2",
			continuity: payload,
		} as unknown as SessionEntryInput,
		{
			kind: "continuityCommit",
			turnId: "a-commit-entry",
			parentTurnId: "m2",
			timestamp: AT,
			continuity: payload,
		} as unknown as SessionEntryInput,
	];
}

describe("P2 and P4 through the capture: a handoff and a fork", () => {
	async function parentWithHandoff(server: CaptureServer) {
		const parent = chatHarness({ server });
		const meta = parent.session.create({ cwd: process.cwd() });
		parent.session.append({ id: "m1", parentId: null, at: AT, kind: "user", payload: { text: "first" } });
		parent.session.append({ id: "m2", parentId: "m1", at: AT, kind: "assistant", payload: { text: "second" } });
		for (const entry of readyHandoff(meta.id)) parent.session.appendEntry(entry);
		parent.session.append({ id: "m3", parentId: "m2", at: AT, kind: "user", payload: { text: "third" } });
		parent.session.append({ id: "m4", parentId: "m3", at: AT, kind: "assistant", payload: { text: "fourth" } });
		return { parent, parentId: meta.id };
	}

	it("P2: a fork at the tip holds the note once, as recall only, and cannot execute the parent's transaction", {
		timeout: 20_000,
	}, async (t) => {
		const server = await startCaptureServer(() => ({ text: "answered" }));
		t.after(() => server.close());
		const { parent, parentId } = await parentWithHandoff(server);
		let childId: string;
		try {
			const child = parent.session.fork("m4");
			childId = child.id;
			ok(childId !== parentId);
		} finally {
			await parent.close();
		}
		const projection = resolveContinuityProjection({
			entries: openSession(childId).turns() as SessionEntry[],
			sessionId: childId,
			fork: { parentSessionId: parentId, parentTurnId: "m4" },
			nowMs: PREPARED_AT + 10_000,
		});
		strictEqual(projection.note, null, "the child projects no executable note");
		strictEqual(projection.current?.phase ?? "absent", "absent", "the child owns no transaction");
		strictEqual(projection.current?.authority ?? "none", "none");
		deepStrictEqual(projection.current?.action ?? { kind: "none" }, { kind: "none" }, "and has nothing to execute");
		strictEqual(projection.inherited.length, 1);
		strictEqual(projection.inherited[0]?.provenance, "inherited");

		const reopened = chatHarness({ server });
		try {
			reopened.reopen(childId);
			await reopened.submit("carry on");
		} finally {
			await reopened.close();
		}
		const request = server.requests.at(-1);
		ok(request);
		const sent = wireElements(request).join("\n");
		strictEqual(count(sent, NOTE.note), 1, "the note reaches the child's request exactly once");
		ok(/recall only/u.test(sent), "labelled recall only");
	});

	it("P4: a fork before the handoff sidecars sends none of them", { timeout: 20_000 }, async (t) => {
		const server = await startCaptureServer(() => ({ text: "answered" }));
		t.after(() => server.close());
		const { parent } = await parentWithHandoff(server);
		let childId: string;
		try {
			childId = parent.session.fork("m2").id;
		} finally {
			await parent.close();
		}
		const reopened = chatHarness({ server });
		try {
			reopened.reopen(childId);
			await reopened.submit("carry on");
		} finally {
			await reopened.close();
		}
		const request = server.requests.at(-1);
		ok(request);
		const sent = JSON.stringify(request.body);
		ok(!sent.includes(NOTE.note), "no continuity note crosses a fork made before it");
		ok(!sent.includes("earlier work summarized"), "nor the summary that carried it");
	});
});

describe("P5: native checkpoints and a portable fallback", () => {
	const account = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } }));
	const apiKey = `e30.${account.toString("base64url")}.sig`;
	const codex = engineModels.getModel("openai-codex" as never, "gpt-6-luna") as EngineModel | undefined;

	function publish(model: EngineModel, encrypted: string): ProviderCheckpointHandle {
		const checkpoint: ProviderCheckpoint = {
			version: 1,
			createdAt: AT,
			sessionId: "s",
			archive: "a",
			cutCursor: "c",
			entryRefs: [],
			receiptRefs: [],
			recallRefs: [],
			skillContext: null,
			outputJson: JSON.stringify([{ type: "compaction", encrypted_content: encrypted }]),
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			compatibility: {
				accountScope: codexAccountScope(apiKey) ?? "",
				provider: model.provider,
				model: model.id,
				protocol: "codex-responses-trigger-v1",
			},
			initialEffort: "medium",
			effectiveEffort: "medium",
			policyDigest: "policy",
		};
		const prepared = prepareProviderCheckpoint(checkpoint);
		prepared.publish();
		return prepared.handle;
	}

	/** The payload Pi's codex serializer builds and Clio's checkpoint hook rewrites; captured before network I/O. */
	async function captured(model: EngineModel, handle: ProviderCheckpointHandle | null): Promise<unknown> {
		let body: unknown;
		const summary = {
			role: "user" as const,
			content: "Summary of earlier work.",
			timestamp: 1,
			...(handle ? { clioProviderCheckpoint: handle } : {}),
		};
		await engineStreamSimple(
			model,
			{ systemPrompt: "Fixture system.", messages: [summary, { role: "user", content: "continue", timestamp: 2 }] },
			{
				apiKey,
				sessionId: "p5",
				clioProviderCompaction: () => true,
				clioCompactionPayload: (payload: unknown) => {
					body = structuredClone(payload);
					throw new Error("captured before network I/O");
				},
				onPayload: (payload: unknown) => {
					if (handle) return payload;
					body = structuredClone(payload);
					throw new Error("captured before network I/O");
				},
			} as never,
		).result();
		ok(body, "the payload was captured");
		return body;
	}

	it("two native checkpoint outputs and a portable fallback produce three different payloads", async () => {
		ok(codex, "openai-codex/gpt-6-luna must exist in the Pi catalog");
		const first = await captured(codex, publish(codex, "native-one"));
		const second = await captured(codex, publish(codex, "native-two"));
		const portable = await captured(codex, null);
		const input = (body: unknown) => JSON.stringify((body as { input?: unknown }).input);
		ok(input(first).includes("native-one"));
		ok(input(second).includes("native-two"));
		ok(input(portable).includes("Summary of earlier work."), "the fallback sends the summary text");
		ok(!input(portable).includes('"compaction"'), "and no opaque item");
		notDeepStrictEqual(first, second);
		notDeepStrictEqual(first, portable);
		notDeepStrictEqual(second, portable);
	});
});
