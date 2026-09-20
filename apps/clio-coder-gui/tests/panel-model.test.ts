import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyState, eyebrow, PANELS } from "../client/design/panel-model.js";

test("every panel eyebrow names a scope and a mutability", () => {
	assert.equal(
		eyebrow("Evidence bundles", "installation-wide", "read only"),
		"EVIDENCE BUNDLES · INSTALLATION-WIDE · READ ONLY",
	);
	const panels = Object.entries(PANELS);
	assert.ok(panels.length >= 9, `expected the inspector panels to be registered, saw ${panels.length}`);
	for (const [id, panel] of panels) {
		const segments = panel.eyebrow.split(" · ");
		assert.ok(segments.length >= 2, `${id} eyebrow states only a scope: ${panel.eyebrow}`);
		assert.equal(panel.eyebrow, panel.eyebrow.toUpperCase(), `${id} eyebrow is not an eyebrow`);
		assert.doesNotMatch(panel.eyebrow, /\.$/u, `${id} eyebrow ends in a period`);
		const mutability = segments.at(-1) as string;
		assert.match(
			mutability,
			/READ ONLY|READ OFFLINE|COLLECT AND RECHECK|INSTALL AND REMOVE/u,
			`${id} does not say what the panel may do to this data: ${mutability}`,
		);
	}
});

test("every panel closes with its own boundary sentence, not boilerplate", () => {
	const seen = new Set<string>();
	for (const [id, panel] of Object.entries(PANELS)) {
		assert.ok(panel.title.length > 0, `${id} has no title`);
		assert.match(panel.boundary, /\.$/u, `${id} boundary is not a sentence: ${panel.boundary}`);
		assert.match(panel.boundary, /machine|host|bundle|report|ledger/u, `${id} boundary names nothing: ${panel.boundary}`);
		assert.equal(seen.has(panel.boundary), false, `${id} repeats another panel's boundary`);
		seen.add(panel.boundary);
	}
});

test("the four empty states stay four different sentences", () => {
	assert.equal(
		emptyState.unread("durable evidence inventory"),
		"The durable evidence inventory has not been read in this session.",
	);
	assert.equal(
		emptyState.missingStore("evaluation"),
		"This installation has no evaluation store at all. That is a missing store, not an empty one.",
	);
	assert.equal(
		emptyState.missingStore("session history", "/home/clio/state/sessions"),
		"This installation has no session history store at all. That is a missing store, not an empty one. Clio Coder looked for it at /home/clio/state/sessions.",
	);
	assert.equal(
		emptyState.emptyStore("evidence bundle"),
		"Clio Coder has recorded no evidence bundle on this installation. This is an empty record, not a health claim.",
	);
	assert.equal(
		emptyState.predatesSchema("bundle", "trust projection", "axes"),
		"This bundle predates the canonical trust projection, so it records no axes to open.",
	);
	// A missing store and an empty store must never collapse into one another.
	assert.notEqual(emptyState.missingStore("evaluation"), emptyState.emptyStore("evaluation"));
	assert.match(emptyState.dash(), /does not mean zero activity/u);
});

test("a bounded list says which end of the window it lost", () => {
	assert.equal(emptyState.bounded("evidence bundles"), "Older evidence bundles are outside this bounded view.");
	assert.equal(emptyState.bounded("phases", "Later"), "Later phases are outside this bounded view.");
});
