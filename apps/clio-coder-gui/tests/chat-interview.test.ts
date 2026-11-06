import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Value } from "typebox/value";
import { INTERVIEW_META_KEY, InterviewRound } from "../contracts/interviews.js";
import { Interviews } from "../server/acp/interviews.js";

(globalThis as { React?: typeof React }).React = React;
register(
	`data:text/javascript,${encodeURIComponent('export async function load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); }')}`,
);
const { InterviewHeading } = await import("../client/chat/Interview.js");

const questions = [{ question: "Which partition?", options: [{ label: "gpu" }, { label: "cpu" }] }];

function parkedRound(meta?: Record<string, unknown>): InterviewRound {
	let round: InterviewRound | null = null;
	const interviews = new Interviews((next) => {
		round = next;
	});
	void interviews.request("s1", "t1", {
		sessionId: "s1",
		interviewId: "i1",
		questions,
		...(meta ? { _meta: meta } : {}),
	});
	assert.ok(round, "the request parks a round");
	assert.ok(Value.Check(InterviewRound, round), "the parked round meets the public round contract");
	return round;
}

test("an interview round is operator_only only when the runtime's interview metadata says so", () => {
	assert.equal(parkedRound({ [INTERVIEW_META_KEY]: { version: 1, operatorOnly: true } }).operatorOnly, true);
	for (const meta of [
		undefined,
		{ [INTERVIEW_META_KEY]: { version: 1, operatorOnly: false } },
		{ [INTERVIEW_META_KEY]: { version: 1, operatorOnly: "true" } },
		{ [INTERVIEW_META_KEY]: null },
		{ other: { operatorOnly: true } },
	])
		assert.equal("operatorOnly" in parkedRound(meta), false, JSON.stringify(meta));
});

test("the interview dialog labels an operator_only round and leaves an ordinary one unlabelled", () => {
	const round = parkedRound();
	const render = (value: InterviewRound) =>
		renderToStaticMarkup(React.createElement(InterviewHeading, { round: value, titleId: "t" }));
	const marked = render({ ...round, operatorOnly: true });
	assert.match(marked, /class="interview-dialog__operator-only"/);
	assert.match(marked, /Operator only/);
	assert.doesNotMatch(render(round), /Operator only|interview-dialog__operator-only/);
});
