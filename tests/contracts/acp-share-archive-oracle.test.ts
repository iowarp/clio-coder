import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { DispatchRequest } from "../../src/domains/dispatch/index.js";
import { createShareBundle } from "../../src/domains/share/extension.js";
import { archiveCommandHost } from "../../src/domains/share/index.js";
import { type AcpCommandHost, acpCommandControl } from "../../src/engine/acp/commands.js";
import { followWorkerRuns } from "../../src/interactive/worker-run-ledger.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const refuse = (member: string) =>
	new Proxy(
		{},
		{
			get() {
				throw new Error(`test host: ${member} was reached`);
			},
		},
	);

function host(overrides: Partial<AcpCommandHost>): AcpCommandHost {
	return {
		dispatch: refuse("dispatch") as AcpCommandHost["dispatch"],
		bus: createSafeEventBus(),
		providers: refuse("providers") as AcpCommandHost["providers"],
		...overrides,
	};
}

const names = (control: ReturnType<typeof acpCommandControl>) => control.catalog().commands.map((row) => row.name);

test("share hands the most recent finished operator run to the model, from the runs this process watched", async () => {
	const bus = createSafeEventBus();
	const ledger = followWorkerRuns(bus, (runId) =>
		runId === "run-1" ? { outcome: "succeeded", exitCode: 0, text: "Sample B reads 4.2." } : null,
	);
	const notes: string[] = [];
	const control = acpCommandControl(
		host({ bus, listWorkerRuns: () => ledger.list(), submitOperatorNote: (text) => notes.push(text) }),
	);
	assert.ok(names(control).includes("share"), "share is offered once its host members are wired");
	const empty = await control.invoke({ command: "share", argv: [] });
	assert.equal(empty.level, "error");
	assert.match(empty.lines.join("\n"), /no finished \/run or \/delegate result to share yet/);
	bus.emit(BusChannels.DispatchStarted, {
		runId: "run-1",
		assignmentId: "run-1",
		attempt: 0,
		requestOrigin: "user",
		agentId: "verifier",
		targetId: "mini",
		wireModelId: "gemma",
		runtimeId: "openai",
		runtimeKind: "http",
		pid: 1,
	} as never);
	bus.emit(BusChannels.DispatchCompleted, {
		runId: "run-1",
		outcome: "succeeded",
		outcomeCode: null,
		outcomeDetail: null,
		tokenCount: 10,
		durationMs: 5,
		exitCode: 0,
		toolActivity: null,
	} as never);
	const shared = await control.invoke({ command: "share", argv: [] });
	assert.notEqual(shared.level, "error", shared.lines.join("\n"));
	assert.equal(notes.length, 1);
	assert.match(notes[0] ?? "", /verifier/);
	assert.match(notes[0] ?? "", /Sample B reads 4\.2\./);
	const unknown = await control.invoke({ command: "share", argv: ["run-9"] });
	assert.equal(unknown.level, "error");
	assert.match(unknown.lines.join("\n"), /no finished run run-9/);
	ledger.dispose();
});

test("oracle dispatches the internal read-only advisor on the active record and shares its answer", async () => {
	const requests: DispatchRequest[] = [];
	let answer: unknown = {
		verdict: "Keep the lexer",
		challenge: "The parser tests are thin",
		changesMyMind: "A failing parser test",
		citedDecisions: [],
	};
	const dispatch = {
		ownsProgressBus: () => true,
		dispatch: async (request: DispatchRequest) => {
			requests.push(request);
			return {
				runId: "oracle-1",
				events: (async function* () {})(),
				finalPromise: Promise.resolve({
					runId: "oracle-1",
					outcome: "succeeded",
					output: { text: JSON.stringify(answer), state: "final", truncated: false },
				}),
			};
		},
	} as unknown as AcpCommandHost["dispatch"];
	const notes: string[] = [];
	let streaming = false;
	const control = acpCommandControl(
		host({
			dispatch,
			submitOperatorNote: (text) => notes.push(text),
			isTurnInFlight: () => streaming,
			oracleBriefing: () => ({ decisions: [], tasks: [], compactionSummary: "We chose a hand-written lexer." }),
		}),
	);
	assert.ok(names(control).includes("oracle"));
	const result = await control.invoke({ command: "oracle", argv: ["Should we keep the lexer?"] });
	assert.notEqual(result.level, "error", result.lines.join("\n"));
	assert.equal(requests.length, 1);
	assert.equal(requests[0]?.agentId, "oracle");
	assert.equal(requests[0]?.readOnly, true);
	assert.equal(requests[0]?.requestOrigin, "internal");
	assert.match(requests[0]?.briefing ?? "", /hand-written lexer/);
	assert.match(requests[0]?.briefing ?? "", /Should we keep the lexer\?/);
	assert.equal(notes.length, 1);
	assert.match(notes[0] ?? "", /Keep the lexer/);
	assert.doesNotMatch(result.lines.join("\n"), /started; progress arrives/, "a finished oracle does not claim to be starting");

	streaming = true;
	const refused = await control.invoke({ command: "oracle", argv: ["Again?"] });
	assert.equal(refused.level, "warn");
	assert.match(refused.lines.join("\n"), /refused rather than queued/);
	assert.equal(requests.length, 1, "a refused oracle dispatches nothing");

	streaming = false;
	answer = "not an oracle report";
	const unusable = await control.invoke({ command: "oracle", argv: ["And now?"] });
	assert.equal(unusable.level, "error");
	assert.match(unusable.lines.join("\n"), /returned no usable answer/);
	assert.equal(notes.length, 1, "an unusable answer is not shared");
});

test("archive exports the project, plans an import dry run, and reports a bad path as a failure", async () => {
	const scratch = await isolateClioEnv("clio-coder-acp-archive-");
	const previous = process.cwd();
	try {
		const root = realpathSync(scratch.dir);
		process.chdir(root);
		mkdirSync(join(root, ".clio-coder", "prompts"), { recursive: true });
		writeFileSync(join(root, ".clio-coder", "prompts", "survey.md"), "---\ndescription: Survey\n---\nSurvey the site.\n");
		const share = createShareBundle({} as DomainContext).contract;
		const control = acpCommandControl(host(archiveCommandHost(share)));
		assert.ok(names(control).includes("archive"));
		const exported = await control.invoke({ command: "archive", argv: ["export", "survey.clio-coder-share"] });
		assert.equal(exported.level, "success", exported.lines.join("\n"));
		assert.match(exported.lines.join("\n"), /exported \d+ item\(s\) to .*survey\.clio-coder-share/);
		assert.ok(existsSync(join(root, "survey.clio-coder-share")));
		const planned = await control.invoke({
			command: "archive",
			argv: ["import", "--dry-run", "survey.clio-coder-share"],
		});
		assert.match(planned.lines.join("\n"), /dry-run write=\d+ overwrite=\d+ skip=\d+/);
		const missing = await control.invoke({ command: "archive", argv: ["import", "--dry-run", "nope.clio-share"] });
		assert.notEqual(missing.level, "success", missing.lines.join("\n"));
		// A regular file where a directory is needed fails at once on every platform.
		const unwritable = await control.invoke({
			command: "archive",
			argv: ["export", "survey.clio-coder-share/out.clio-share"],
		});
		assert.equal(unwritable.level, "error", unwritable.lines.join("\n"));
	} finally {
		process.chdir(previous);
		scratch.restore();
	}
});
