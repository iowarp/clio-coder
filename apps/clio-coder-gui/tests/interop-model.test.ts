import assert from "node:assert/strict";
import { test } from "node:test";
import {
	adapterText,
	type InteropAgent,
	interopSummary,
	orderedAgents,
	presenceMark,
	versionText,
	wiringMark,
	wiringSentence,
} from "../client/pages/interop-model.js";

const agent = (over: Partial<InteropAgent>): InteropAgent => ({
	kind: "codex",
	label: "Codex",
	hasExecutable: true,
	presence: "present",
	binary: "/usr/bin/codex",
	version: "1.2.3",
	versionSource: "probed",
	installDir: null,
	adapter: "present",
	decision: null,
	decidedAt: null,
	decisionStale: false,
	wiring: "proposed",
	skillCount: 0,
	projectArtifacts: 0,
	inventory: { status: "known", listing: "unknown", diagnostics: [], items: [] },
	...over,
});

test("the wiring states never share a sentence", () => {
	const sentences = [
		wiringSentence(agent({ wiring: "configured" })),
		wiringSentence(agent({ wiring: "not-acp", adapter: null })),
		wiringSentence(agent({ wiring: "proposed" })),
		wiringSentence(agent({ wiring: "proposed", decision: "declined", decisionStale: true })),
		wiringSentence(agent({ wiring: "decided", decision: "declined" })),
		wiringSentence(agent({ wiring: "decided", decision: "accepted" })),
		wiringSentence(agent({ wiring: "not-offered", presence: "absent" })),
		wiringSentence(agent({ wiring: "not-offered", presence: "unknown" })),
		wiringSentence(agent({ wiring: "unknown" })),
	];
	assert.equal(new Set(sentences).size, sentences.length);
	assert.deepEqual(sentences.slice(0, 6), [
		"Wired as a delegation peer.",
		"Speaks no ACP, so Clio Coder cannot delegate to it.",
		"Offered, and never answered.",
		"Offered again, because the facts moved since you last answered.",
		"Declined, so Clio Coder stays quiet about it.",
		"Accepted, but no delegation entry names it.",
	]);
	for (const sentence of sentences) assert.match(sentence, /\.$/u);
});

test("an offer says when accepting it would reach the network", () => {
	assert.match(
		wiringSentence(agent({ wiring: "proposed", adapter: "absent" })),
		/fetch its ACP adapter from the network/u,
	);
	assert.doesNotMatch(wiringSentence(agent({ wiring: "proposed", adapter: "present" })), /network/u);
});

test("marks keep unknown apart from absent, and a kind with no executable is not an absence", () => {
	assert.deepEqual(presenceMark(agent({})), { tone: "success", label: "Installed" });
	assert.deepEqual(presenceMark(agent({ presence: "absent" })), { tone: "neutral", label: "Not installed" });
	assert.deepEqual(presenceMark(agent({ presence: "unknown" })), {
		tone: "unverified",
		label: "Could not be determined",
	});
	assert.equal(presenceMark(agent({ hasExecutable: false, presence: "absent" })).label, "Shared resource conventions");
	assert.equal(wiringMark(agent({ wiring: "configured" })).tone, "success");
	assert.equal(wiringMark(agent({ wiring: "proposed" })).label, "Waiting for your answer");
	assert.equal(wiringMark(agent({ wiring: "unknown" })).tone, "unverified");
	assert.equal(adapterText(null), "No recipe");
	assert.equal(adapterText("absent"), "Would be fetched on first use");
	assert.equal(adapterText("unknown"), "Could not be determined");
});

test("the summary counts detected of known kinds, peers and offers, and unreadable settings are not zero", () => {
	const report = {
		detectedAt: "2026-01-02T03:04:05.000Z",
		agents: [
			agent({ kind: "a", wiring: "configured" }),
			agent({ kind: "b", wiring: "proposed" }),
			agent({ kind: "c", wiring: "not-offered", presence: "absent", binary: null, version: null }),
			agent({ kind: "d", wiring: "not-acp", presence: "absent", installDir: "/home/x/.d" }),
		],
	};
	const summary = interopSummary(report);
	assert.deepEqual(
		summary.slice(0, 3).map((figure) => [figure.label, figure.value]),
		[
			["Detected", "3 of 4 known kinds"],
			["Wired as peers", "1"],
			["Would be offered", "1"],
		],
	);
	assert.deepEqual(
		orderedAgents(report).map((row) => row.kind),
		["a", "b", "d", "c"],
	);
	const unreadable = interopSummary({
		...report,
		agents: report.agents.map((row) => ({ ...row, wiring: "unknown" as const })),
	});
	assert.equal(unreadable[1]?.value, "Not established");
	assert.equal(unreadable[2]?.value, "Not established");
});

test("a version says whether it was probed now or only recorded, and a missing one says how to get it", () => {
	assert.equal(versionText(agent({})), "1.2.3 · probed just now");
	assert.equal(versionText(agent({ versionSource: "recorded" })), "1.2.3 · last recorded");
	assert.match(versionText(agent({ version: null, versionSource: null })), /Detect again/u);
	assert.equal(versionText(agent({ version: null, versionSource: null, presence: "absent" })), "Not reported");
});
