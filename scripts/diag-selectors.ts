/**
 * Diag: exercise the Phase 11 foundation surface (provider resolver plus
 * clio --list-models). Later slices extend this file with overlay and
 * keybinding checks. Exits 0 on success, 1 on the first failure.
 */

import assert from "node:assert/strict";
import { listModels } from "../src/cli/list-models.js";
import {
	VALID_THINKING_LEVELS,
	parseModelPattern,
	resolveModelPattern,
	resolveModelScope,
} from "../src/domains/providers/resolver.js";
import { ALT_M, SHIFT_TAB, parseSlashCommand, routeInteractiveKey } from "../src/interactive/index.js";
import { buildThinkingItems } from "../src/interactive/overlays/thinking-selector.js";

function ok(name: string): void {
	process.stdout.write(`[diag-selectors] ok ${name}\n`);
}

function fail(name: string, err: unknown): never {
	const msg = err instanceof Error ? err.message : String(err);
	process.stderr.write(`[diag-selectors] FAIL ${name}: ${msg}\n`);
	process.exit(1);
}

function run(name: string, fn: () => void): void {
	try {
		fn();
		ok(name);
	} catch (err) {
		fail(name, err);
	}
}

// parseModelPattern
run("parseModelPattern plain id", () => {
	assert.deepEqual(parseModelPattern("gpt-5"), { model: "gpt-5" });
});
run("parseModelPattern provider/id", () => {
	assert.deepEqual(parseModelPattern("openai/gpt-5"), { provider: "openai", model: "gpt-5" });
});
run("parseModelPattern provider/id:thinking", () => {
	assert.deepEqual(parseModelPattern("openai/gpt-5:high"), {
		provider: "openai",
		model: "gpt-5",
		thinkingLevel: "high",
	});
});
run("parseModelPattern empty returns null", () => {
	assert.equal(parseModelPattern(""), null);
});

// resolveModelPattern. openai/gpt-5 is a real entry in PROVIDER_CATALOG.
run("resolveModelPattern exact hit", () => {
	const r = resolveModelPattern("openai/gpt-5");
	assert.equal(r.matches.length, 1);
	assert.equal(r.matches[0].providerId, "openai");
	assert.equal(r.matches[0].modelId, "gpt-5");
});
run("resolveModelPattern no match returns diagnostic", () => {
	// Scoped to openai so the bare-id fallback on local engines cannot match.
	const r = resolveModelPattern("openai/xyzzy-nothing-matches");
	assert.equal(r.matches.length, 0);
	assert.ok(r.diagnostic);
});

// resolveModelScope dedupes and preserves first-match order.
run("resolveModelScope dedupe preserves first-match order", () => {
	const r = resolveModelScope(["openai/gpt-5", "openai/gpt-5", "anthropic/claude-sonnet-4-6"]);
	assert.equal(r.matches.length, 2);
	assert.equal(r.matches[0].modelId, "gpt-5");
	assert.equal(r.matches[1].modelId, "claude-sonnet-4-6");
});

// listModels as a pure function with a stdout seam.
run("listModels empty search dumps catalog", () => {
	const lines: string[] = [];
	const code = listModels({ stdout: (line) => lines.push(line) });
	assert.equal(code, 0);
	assert.ok(lines.some((l) => l.includes("anthropic")));
	assert.ok(lines.some((l) => l.includes("openai")));
});
run("listModels no match returns exit 1", () => {
	// Scoped to openai so the bare-id fallback on local engines cannot match.
	const lines: string[] = [];
	const code = listModels({ search: "openai/xyzzy-nothing-matches", stdout: (line) => lines.push(line) });
	assert.equal(code, 1);
});

// Slice 2: thinking selector + Shift+Tab rebind.
run("parseSlashCommand /thinking", () => {
	assert.deepEqual(parseSlashCommand("/thinking"), { kind: "thinking" });
});
run("buildThinkingItems marks current level with a filled dot", () => {
	const items = buildThinkingItems("high", VALID_THINKING_LEVELS);
	assert.equal(items.length, 6);
	const high = items.find((item) => item.value === "high");
	assert.ok(high);
	assert.ok(high.label.includes("●"));
	const off = items.find((item) => item.value === "off");
	assert.ok(off);
	assert.ok(!off.label.includes("●"));
});
run("routeInteractiveKey Shift+Tab triggers cycleThinking", () => {
	let thinking = 0;
	let mode = 0;
	const consumed = routeInteractiveKey(SHIFT_TAB, {
		cycleMode: () => {
			mode += 1;
		},
		cycleThinking: () => {
			thinking += 1;
		},
		requestShutdown: () => {},
		requestSuper: () => {},
		toggleDispatchBoard: () => {},
	});
	assert.equal(consumed, true);
	assert.equal(thinking, 1);
	assert.equal(mode, 0);
});
run("routeInteractiveKey Alt+M triggers cycleMode", () => {
	let thinking = 0;
	let mode = 0;
	const consumed = routeInteractiveKey(ALT_M, {
		cycleMode: () => {
			mode += 1;
		},
		cycleThinking: () => {
			thinking += 1;
		},
		requestShutdown: () => {},
		requestSuper: () => {},
		toggleDispatchBoard: () => {},
	});
	assert.equal(consumed, true);
	assert.equal(mode, 1);
	assert.equal(thinking, 0);
});

process.stdout.write("[diag-selectors] all checks ok\n");
