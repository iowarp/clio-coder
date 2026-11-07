import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { Client } from "../client/api/client.js";
import { paneGate } from "../client/chat/pane-model.js";
import { sparkline } from "../client/pages/operator-metrics-model.js";
import { settingsControlSelection } from "../client/pages/settings-control-model.js";
import type { SessionSummary } from "../contracts/sessions.js";
import type { SettingsControls } from "../contracts/settings-controls.js";

(globalThis as { React?: typeof React }).React = React;
register(
	`data:text/javascript,${encodeURIComponent('export async function load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); }')}`,
);
const { LibraryCatalog } = await import("../client/pages/library-catalog.js");
const { SettingsControlsView } = await import("../client/pages/settings-controls.js");
const { ModelsSettings } = await import("../client/pages/settings-sections.js");
const { SettingsSidebar } = await import("../client/shell/SettingsSidebar.js");
const { ShellContext } = await import("../client/shell/shell-context.js");
const { SettingsPage } = await import("../client/pages/settings.js");
const { SystemPage } = await import("../client/pages/system.js");
const { Toolchain } = await import("../client/pages/toolchain.js");
const { Sessions, TaskHistoryActions } = await import("../client/pages/tasks.js");
const { MissionControl } = await import("../client/pages/mission-control.js");
const { SessionControlsProvider } = await import("../client/shell/SessionControls.js");
const { useWorkspaceSelection, WorkspacePicker } = await import("../client/pages/workspace-selection.js");
const { OperatorMetrics } = await import("../client/pages/operator-metrics.js");
const { sessionOperatorMetrics, goldenTelemetryRecords } = await import("./harness/telemetry-fixture.js");
const client = { token: "test", call: () => new Promise(() => {}) } as unknown as Client;
const queries = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
test("closed tasks expose recorded usage without enabling live-only inspectors", () => {
	assert.equal(paneGate("usage", false, undefined), "ready");
	assert.equal(paneGate("context", false, undefined), "closed");
	assert.equal(paneGate("usage", true, undefined), "checking");
});
function render(cache: QueryClient, path: string, node: ReactNode) {
	return renderToStaticMarkup(
		<QueryClientProvider client={cache}>
			<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>
		</QueryClientProvider>,
	);
}
const controls: SettingsControls = {
	userFile: "/scratch/config/settings.yaml",
	sections: [{ id: "chat", label: "Chat", description: "Conversation preferences" }],
	controls: [
		{
			path: "chat.thinkingLevel",
			section: "chat",
			group: "Responses",
			label: "Thinking level",
			description: "Reasoning budget",
			valueHelp: {},
			kind: "string",
			optional: false,
			timing: "nextTurn",
			value: "high",
			source: "project",
			access: "read-only",
			reason: "A project file sets this value.",
		},
	],
};

test("operator tables expose recorded model, target, latency, tool and compaction measures without expanding prose", () => {
	const metrics = sessionOperatorMetrics({
		sessionId: "operator-render",
		journal: {
			present: true,
			records: goldenTelemetryRecords("operator-render"),
			modes: ["standard"],
			skipped: 0,
			damaged: 0,
		},
		runs: new Map(),
		parent: null,
	});
	const html = render(queries(), "/metrics", <OperatorMetrics client={client} {...metrics} />);
	for (const label of [
		"Per model",
		"Per target",
		"Cache read",
		"Cache / prompt",
		"Main TTFT p50 / p95",
		"Tool reliability",
		"Compactions",
	])
		assert.ok(html.includes(label), label);
	assert.ok(html.includes("operator-render"));
	assert.deepEqual(
		sparkline([10, null, 20]).map((segment) => segment.length),
		[1, 1],
	);
	assert.deepEqual(sparkline([null, null]), []);
	assert.equal(sparkline([0])[0]?.[0]?.y, 15, "a recorded zero is a real point");
});

test("settings model catalogs follow the displayed scope, search and compact selection", () => {
	const base = controls.controls[0];
	assert.ok(base);
	const report: SettingsControls = {
		...controls,
		sections: [...controls.sections, { id: "safety", label: "Safety", description: "Limits" }],
		controls: [
			{ ...base, path: "chat.model" },
			{ ...base, path: "safety.limits.toolCallsPerTurn", section: "safety", label: "Tool calls" },
		],
	};
	const discovery = {
		scope: undefined,
		filter: "",
		section: null,
		showDrafts: false,
		drafts: {},
		compact: false,
		selectedControl: null,
	};
	const paths = (selection: ReturnType<typeof settingsControlSelection>) =>
		selection.editorControls.map((control) => control.path);
	assert.deepEqual(paths(settingsControlSelection(report, discovery)), ["chat.model"]);
	assert.deepEqual(paths(settingsControlSelection(report, { ...discovery, scope: "safety" })), [
		"safety.limits.toolCallsPerTurn",
	]);
	assert.deepEqual(paths(settingsControlSelection(report, { ...discovery, filter: "does-not-exist" })), []);
	assert.deepEqual(
		paths(
			settingsControlSelection(report, {
				...discovery,
				compact: true,
				section: "all",
				selectedControl: "safety.limits.toolCallsPerTurn",
			}),
		),
		["safety.limits.toolCallsPerTurn"],
	);
});

function ProjectPicker() {
	return <WorkspacePicker selection={useWorkspaceSelection(client)} />;
}

test("project and session toolbar controls retain names when their visible text is hidden on phones", () => {
	const project = render(
		queries(),
		"/workspaces/workspace-1/sessions",
		<SessionControlsProvider client={client}>
			<Sessions client={client} />
		</SessionControlsProvider>,
	);
	assert.match(project, /aria-label="Project settings"/);
	assert.match(project, /aria-label="(?:Updating|Refresh) project work"/);
	const sessions = render(
		queries(),
		"/sessions",
		<SessionControlsProvider client={client}>
			<MissionControl client={client} />
		</SessionControlsProvider>,
	);
	for (const label of ["Trace replay", "Evidence", "Machines"]) assert.ok(sessions.includes(`aria-label="${label}"`));
	assert.match(sessions, /aria-label="(?:Updating|Refresh) sessions"/);
});

test("read-only project inspection never describes a save and an empty project list has a working open action", () => {
	const cache = queries();
	cache.setQueryData(["workspaces"], [{ id: "workspace-1", name: "Scratch", path: "/scratch" }]);
	const html = render(cache, "/usage?workspace=workspace-1", <ProjectPicker />);
	assert.match(html, /Choose the project to inspect/);
	assert.doesNotMatch(html, /saves go|user settings/);
	cache.setQueryData(["workspaces"], []);
	const empty = render(cache, "/usage", <ProjectPicker />);
	assert.match(empty, /href="\/"[^>]*>Open a workspace/);
	assert.doesNotMatch(empty, /href="\/sessions"/);
});

test("saved project tasks can be renamed without resuming and only closed, unheld tasks offer deletion", () => {
	const summary: SessionSummary = {
		id: "saved-1",
		workspaceId: "workspace-1",
		name: "Sensor notes",
		createdAt: "2026-09-26T12:00:00Z",
		endedAt: "2026-09-26T13:00:00Z",
		model: null,
		target: null,
	};
	const row = {
		id: summary.id,
		workspaceId: summary.workspaceId,
		title: "Sensor notes",
		open: false,
		state: "idle" as const,
		at: summary.createdAt,
	};
	const html = render(
		queries(),
		"/workspaces/workspace-1/sessions",
		<TaskHistoryActions client={client} row={row} summary={summary} />,
	);
	assert.match(html, /aria-label="Rename Sensor notes"/);
	assert.match(html, /aria-label="Delete Sensor notes"/);
	for (const [held, endedAt] of [
		[true, summary.endedAt],
		[false, null],
	] as const) {
		const protectedHtml = render(
			queries(),
			"/workspaces/workspace-1/sessions",
			<TaskHistoryActions client={client} row={{ ...row, open: held }} summary={{ ...summary, endedAt }} />,
		);
		assert.match(protectedHtml, /aria-label="Rename Sensor notes"/);
		assert.doesNotMatch(protectedHtml, /aria-label="Delete Sensor notes"/);
	}
});

test("a URL-selected package beyond the local page limit is inspectable without offering an unstaged apply", () => {
	const packages = Array.from({ length: 45 }, (_, index) => ({
		ref: `skill:item-${index}`,
		kind: "skill",
		name: `item-${index}`,
		description: "Catalog package",
		sourceUrl: `bundled/item-${index}`,
		catalogOrigin: "catalog",
		origin: { kind: "bundled" },
		copies: [],
	}));
	const html = render(
		queries(),
		"/library?package=skill%3Aitem-44",
		<LibraryCatalog client={client} workspaceId="workspace-1" packages={packages} filter="" />,
	);
	assert.match(html, /aria-label="skill:item-44"/);
	assert.match(html, /Package source &amp; requirements/);
	assert.match(html, /bundled\/item-44/);
	assert.match(html, /Review the exact files|review the exact files/);
	assert.doesNotMatch(html, />Apply /);
});

test("Settings search uses the URL and points an overridden control to its effective source", () => {
	const cache = queries();
	cache.setQueryData(["settings-controls", "workspace-1"], controls);
	const html = render(
		cache,
		"/settings?workspace=workspace-1&q=chat.thinkingLevel",
		<SettingsControlsView client={client} workspaceId="workspace-1" />,
	);
	assert.match(html, /value="chat.thinkingLevel"/);
	assert.match(html, /href="\/settings\/effective\?workspace=workspace-1&amp;q=chat.thinkingLevel"/);
	assert.match(html, /A project file sets this value/);
	assert.match(html, /<output>high<\/output>/);
	assert.doesNotMatch(html, />Save<\/button>/);
});

test("effective settings keep masked values and offer a control lookup with workspace context", () => {
	const cache = queries();
	cache.setQueryData(["workspaces"], [{ id: "workspace-1", name: "Scratch", path: "/scratch" }]);
	cache.setQueryData(["workspace-settings", "workspace-1"], {
		layers: [],
		issues: [],
		rows: [{ key: "targets", source: "user", value: "Hidden", redacted: true }],
	});
	const html = render(
		cache,
		"/settings/effective?workspace=workspace-1",
		<SettingsPage client={client} view="effective" />,
	);
	assert.match(html, /Sensitive content hidden/);
	assert.match(html, /href="\/settings\?workspace=workspace-1&amp;q=targets"/);
	assert.match(html, /Setting precedence, lowest to highest/);
});

test("System prioritizes warnings even when doctor marked the observed condition ok", () => {
	const cache = queries();
	cache.setQueryData(["system"], {
		checkedAt: "2026-09-26T12:00:00Z",
		paths: { config: "/scratch/config" },
		findings: [
			{ name: "installation", ok: true, level: "warn", detail: "Not set up", detailRedacted: false },
			{ name: "platform", ok: true, level: "ok", detail: "linux", detailRedacted: false },
		],
	});
	const html = render(cache, "/system?attention=true", <SystemPage client={client} />);
	assert.match(html, /Not set up/);
	assert.doesNotMatch(html, />linux</);
	assert.match(html, /1 warning to review/);
	assert.doesNotMatch(html, />Repair<\/button>/);
});

test("Toolchain distinguishes a PATH executable from an installed vendored copy", () => {
	const cache = queries();
	cache.setQueryData(
		["tools"],
		[
			{
				id: "herdr",
				version: "1.0.0",
				summary: "Pinned utility",
				license: "MIT",
				platform: "linux-x64",
				supported: true,
				installed: true,
				installDir: "/scratch/tools/herdr/1.0.0",
				resolution: {
					source: "path",
					binaryPath: "/scratch/path/herdr",
					version: "2.0.0",
					description: "PATH resolution",
					vendoredPath: "/scratch/tools/herdr/1.0.0/herdr",
					pathCandidate: { path: "/scratch/path/herdr", version: "2.0.0", satisfiesMinimum: true },
				},
			},
		],
	);
	const html = render(cache, "/toolchain", <Toolchain client={client} />);
	assert.match(html, /Using PATH/);
	assert.match(html, /Resolved version/);
	assert.match(html, /2.0.0/);
	assert.match(html, /\/scratch\/path\/herdr/);
	assert.match(html, /\/scratch\/tools\/herdr\/1.0.0\/herdr/);
	assert.match(html, /Remove deletes only the vendored copy/);
});

const shell = {
	sidebarCollapsed: false,
	revealSidebar() {},
	startTask() {},
	openWorkspace() {},
	openHelp() {},
	activeWorkspaceId: "workspace-b",
	starting: false,
	asideSlot: null,
};

for (const [path, expected] of [
	["/settings/models", "workspace-b"],
	["/settings/models?workspace=workspace-a&q=chat.thinkingLevel&run=old", "workspace-a"],
]) {
	test(`settings picker and controls share the resolved workspace at ${path}`, () => {
		const cache = queries();
		cache.setQueryData(
			["workspaces"],
			[
				{ id: "workspace-a", name: "First", path: "/scratch/a" },
				{ id: "workspace-b", name: "Active", path: "/scratch/b" },
			],
		);
		for (const id of ["workspace-a", "workspace-b"])
			cache.setQueryData(["settings-controls", id], {
				...controls,
				controls: controls.controls.map((control) => ({ ...control, group: "Model & responses", value: `${id}-value` })),
			});
		const html = render(
			cache,
			path as string,
			<ShellContext.Provider value={shell}>
				<ModelsSettings client={client} />
			</ShellContext.Provider>,
		);
		assert.match(html, new RegExp(`<option value="${expected}" selected=""`));
		assert.match(html, new RegExp(`<output>${expected}-value</output>`));
		assert.match(html, new RegExp(`href="/settings/targets\\?workspace=${expected}"`));
		assert.match(html, new RegExp(`href="/settings/routing\\?workspace=${expected}"`));
	});
}

for (const [path, expected] of [
	["/settings/models?q=stale&run=old", "workspace-b"],
	["/settings/models?workspace=workspace-a&q=stale&run=old", "workspace-a"],
]) {
	test(`settings sidebar keeps only the selected workspace at ${path}`, () => {
		const html = render(
			queries(),
			path as string,
			<SettingsSidebar activeWorkspaceId="workspace-b" onNavigate={() => {}} onHelp={() => {}} />,
		);
		const links = [...html.matchAll(/href="([^"]+)"/g)].map((match) => new URL(match[1] as string, "http://gui.test"));
		assert.ok(links.some((link) => link.pathname === "/library"));
		for (const link of links) assert.deepEqual([...link.searchParams], [["workspace", expected]]);
	});
}
