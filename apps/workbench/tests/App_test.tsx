import { equal, match, ok } from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { type WorkbenchActions, WorkbenchView } from "../src/App.tsx";
import { appReducer, initialAppState } from "../src/state.ts";
import { bootstrapFixture } from "./fixtures.ts";

const inertActions: WorkbenchActions = {
	selectProject() {},
	selectEngine() {},
	probeEngine() {},
	startTurn() {},
	cancelTurn() {},
	resolvePermission() {},
	createProject() {},
	registerProject() {},
	refreshTree() {},
	createNode() {},
	moveNode() {},
	prepareDelete() {},
	confirmDelete() {},
};

Deno.test("Workbench shell renders accessible landmarks, names, live regions, and non-color status text", () => {
	const bootstrap = bootstrapFixture();
	bootstrap.projects[0]!.tree = [
		{
			name: "analysis",
			path: { segments: ["analysis"] },
			kind: "directory",
			operable: true,
			children: [
				{
					name: "convergence.md",
					path: { segments: ["analysis", "convergence.md"] },
					kind: "file",
					operable: true,
				},
			],
		},
	];
	const state = appReducer(initialAppState, { type: "bootstrap.loaded", payload: bootstrap });
	const html = renderToStaticMarkup(<WorkbenchView state={state} dispatch={() => undefined} actions={inertActions} />);

	match(html, /<main class="conversation" id="conversation">/u);
	match(html, /aria-label="Projects, files, and sessions"/u);
	match(html, /aria-label="Activity and evidence"/u);
	match(html, /aria-label="Request, work, change, check, and outcome timeline"/u);
	match(html, /aria-live="assertive"/u);
	match(html, /aria-live="polite"/u);
	match(html, /class="file-tree"/u);
	match(html, /class="file-node file-node--file"/u);
	match(html, /aria-pressed="false"/u);
	match(html, /aria-label="Research request"/u);
	match(html, />Ready</u);
	match(html, /Project engine/u);
	match(html, /Fake mode makes no provider request/u);
	match(html, /Run fake session/u);
	ok(!html.includes("undefined"));
	ok(!html.includes("No prompt leaves this machine"));
	equal((html.match(/<main/gu) ?? []).length, 1);
});

Deno.test("Clio mode exposes explicit readiness and remote-target truth without fake controls", () => {
	const bootstrap = bootstrapFixture();
	const workspace = bootstrap.projects[0]!;
	workspace.engine = {
		...workspace.engine,
		kind: "clio-acp",
		phase: "ready",
		checkedAt: "2026-08-17T12:00:30.000Z",
		facts: workspace.engine.facts.map((fact) => ({
			...fact,
			state: fact.key === "runtime" || fact.key === "protocol" || fact.key === "project" ? "ready" : "unavailable",
			source: "observed-by-workbench",
		})),
	};
	workspace.sessions.push({
		id: "session-current-0001",
		label: "Current process turn",
		preview: "Completed in this process",
		updatedAt: "2026-08-17T12:00:00.000Z",
		status: "complete",
	});
	const state = appReducer(initialAppState, { type: "bootstrap.loaded", payload: bootstrap });
	const html = renderToStaticMarkup(<WorkbenchView state={state} dispatch={() => undefined} actions={inertActions} />);

	match(html, /Check Clio readiness/u);
	match(html, /Workbench sends this prompt only through the configured Clio target/u);
	match(html, /That target may be remote/u);
	match(html, /Run with Clio/u);
	match(html, /Clio readiness facts/u);
	match(html, /Observed by Workbench/u);
	match(html, /CURRENT PROCESS · NO RESUME/u);
	match(html, /ACP session load, replay, and resume are unavailable/u);
	match(html, /Current process turn/u);
	ok(!html.includes("2026-08-17T12:00:00.000Z"));
	ok(!html.includes("Fake outcome"));
	ok(!html.includes("Run fake session"));
	ok(!html.includes("No prompt leaves this machine"));
});

Deno.test("permission card renders only the safe one-use challenge projection", () => {
	const bootstrap = bootstrapFixture();
	const workspace = bootstrap.projects[0]!;
	workspace.engineGeneration = "generation-safe-0001";
	workspace.activeTurnId = "turn-safe-0001";
	workspace.engine = { ...workspace.engine, kind: "clio-acp", phase: "awaiting-approval" };
	workspace.pendingPermission = {
		permissionId: "permission-internal-0001",
		toolCallId: "tool-internal-0001",
		title: "Update project file",
		kind: "edit",
		locations: [{ segments: ["src", "solver.ts"] }],
		expiresAt: "2026-08-17T12:05:00.000Z",
		source: "observed-on-acp",
	};
	const state = appReducer(initialAppState, { type: "bootstrap.loaded", payload: bootstrap });
	const html = renderToStaticMarkup(<WorkbenchView state={state} dispatch={() => undefined} actions={inertActions} />);

	match(html, /PERMISSION NEEDED · ONE USE/u);
	match(html, /Update project file/u);
	match(html, /bounded <strong>edit<\/strong> action/u);
	match(html, /src\/solver\.ts/u);
	match(html, /Observed on ACP/u);
	match(html, /Allow once applies only to this exact action/u);
	match(html, />Reject</u);
	match(html, />Allow once</u);
	ok(!html.includes("permission-internal-0001"));
	ok(!html.includes("tool-internal-0001"));
});

Deno.test("fake permission copy remains explicitly simulated and never attributes the request to Clio", () => {
	const bootstrap = bootstrapFixture();
	const workspace = bootstrap.projects[0]!;
	workspace.engineGeneration = "generation-fake-permission-0001";
	workspace.activeTurnId = "turn-fake-permission-0001";
	workspace.engine = { ...workspace.engine, phase: "awaiting-approval" };
	workspace.pendingPermission = {
		permissionId: "permission-fake-0001",
		toolCallId: "tool-fake-0001",
		title: "Record the fake artifact?",
		kind: "edit",
		locations: [{ segments: ["analysis", "fixture.md"] }],
		expiresAt: "2026-08-17T12:05:00.000Z",
		source: "simulated-by-workbench",
	};
	const state = appReducer(initialAppState, { type: "bootstrap.loaded", payload: bootstrap });
	const html = renderToStaticMarkup(<WorkbenchView state={state} dispatch={() => undefined} actions={inertActions} />);

	match(html, /The Workbench simulation is demonstrating a bounded <strong>edit<\/strong> permission boundary/u);
	match(html, /No Clio or provider request is involved/u);
	match(html, /Simulated by Workbench/u);
	ok(!html.includes("Clio requested permission"));
});

Deno.test("active work disables project and engine retargeting with cancel-first guidance", () => {
	const bootstrap = bootstrapFixture();
	const workspace = bootstrap.projects[0]!;
	workspace.engineGeneration = "generation-active-0001";
	workspace.activeTurnId = "turn-active-0001";
	workspace.engine = { ...workspace.engine, phase: "running" };
	const state = appReducer(initialAppState, { type: "bootstrap.loaded", payload: bootstrap });
	const html = renderToStaticMarkup(<WorkbenchView state={state} dispatch={() => undefined} actions={inertActions} />);

	match(html, /Cancel the active turn before switching projects or engines/u);
	match(html, /title="Cancel the active turn before switching projects\."/u);
	match(html, /title="Cancel the active turn before changing engines\."/u);
	match(html, /<option value="fake" selected="">Fake<\/option>/u);
	match(html, />Cancel</u);
	ok((html.match(/disabled=""/gu) ?? []).length >= 4);
});

Deno.test("loading and failed boot states remain meaningful without animation or color", () => {
	const loading = renderToStaticMarkup(
		<WorkbenchView state={initialAppState} dispatch={() => undefined} actions={inertActions} />,
	);
	match(loading, /aria-busy="true"/u);
	match(loading, /Calibrating the localhost instrument/u);

	const failedState = appReducer(initialAppState, {
		type: "bootstrap.failed",
		message: "Bounded bootstrap diagnostic",
	});
	const failed = renderToStaticMarkup(
		<WorkbenchView state={failedState} dispatch={() => undefined} actions={inertActions} />,
	);
	match(failed, /role="alert"/u);
	match(failed, /Bounded bootstrap diagnostic/u);
	match(failed, /Retry bootstrap/u);
});
