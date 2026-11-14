import assert from "node:assert/strict";
import { test } from "node:test";
import { metricsScopeNote, recordedSessionsLabel, sessionTitle } from "../client/pages/metrics-scope-model.js";

const tasks = [
	{ id: "seeded-1", title: "Survey renamed R2" },
	{ id: "seeded-2", title: "Calibrate" },
	{ id: "fresh-1", title: "New work" },
];

test("recorded sessions are named by their task's title, the id only when no task lists them", () => {
	const titles = new Map(tasks.map((task) => [task.id, task.title]));
	assert.equal(sessionTitle("seeded-1", titles), "Survey renamed R2");
	assert.equal(sessionTitle("0123456789abcdef", titles), "0123456789ab");
});

test("the scope note names the tasks the metrics leave out and says why", () => {
	assert.equal(
		metricsScopeNote({ recorded: ["seeded-1", "seeded-2", "fresh-1"], recordedCount: 3, tasks, project: true }),
		"Covers all of this project's 3 tasks.",
	);
	const missing = metricsScopeNote({ recorded: ["seeded-1", "seeded-2"], recordedCount: 2, tasks, project: true });
	assert.match(missing ?? "", /^Covers 2 of this project's 3 tasks\. Not counted.*“New work”\.$/u);
	const older = metricsScopeNote({ recorded: ["seeded-1"], recordedCount: 5, tasks, project: false });
	assert.match(older ?? "", /^Shows the 1 most recent of 5 recorded sessions\./u);
	assert.equal(metricsScopeNote({ recorded: [], recordedCount: 0, tasks: [], project: true }), null);
});

test("the header count reads whole or as the most recent share", () => {
	assert.equal(recordedSessionsLabel(1, 1), "1 recorded session");
	assert.equal(recordedSessionsLabel(3, 3), "3 recorded sessions");
	assert.equal(recordedSessionsLabel(3, 8), "3 most recent of 8 recorded sessions");
});
