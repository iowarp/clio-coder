import assert from "node:assert/strict";
import path from "node:path";
import { it } from "node:test";
import {
	parseResultContract,
	parseWorkerResultContract,
	RESULT_CONTRACT_REPAIR_LIMIT,
	type ResultContract,
	resultContractRepairMessages,
	resultContractShape,
	resultContractSourceId,
	validateRecipeResult,
	validateResultContract,
} from "../../src/domains/agents/result-contract.js";

const cwd = path.resolve("artifact-fixture");
const contract = { kind: "artifact-report", path: ".clio-coder/staging/core/page.md" } satisfies ResultContract;
const target = path.resolve(cwd, contract.path);
const markup = `<tool_call><function=write><parameter=path>${target}</parameter></function></tool_call>`;

it("checks the exact required artifact, independently of terminal prose or literal tool markup", () => {
	for (const [label, content, reason] of [
		["missing", null, "missing or unreadable"],
		["unreadable", null, "missing or unreadable"],
		["empty", "", "empty"],
		["whitespace", " \n\t", "empty"],
		["nonempty seed", "# Existing page\n", undefined],
	] as const) {
		for (const output of [markup, "The requested page is complete.", null]) {
			const reads: string[] = [];
			const filesystem = {
				readFile(filePath: string) {
					reads.push(filePath);
					// Another readable file must never satisfy this contract.
					return filePath === target ? content : "# Wrong sibling";
				},
			};
			const input = { contract, output, cwd, filesystem, networkAllowed: false };
			const validation = validateResultContract(input);
			assert.equal(validation.conformance, reason ? "fail" : "pass", label);
			assert.equal(validation.quality, "unmeasured");
			if (reason) assert.equal(validation.reason, `Required artifact is ${reason}: ${JSON.stringify(contract.path)}`);
			const receipt = validateRecipeResult({ ...input, reachedTerminalResult: true });
			assert.equal(receipt?.fact.conformance, validation.conformance);
			assert.equal(receipt?.fact.quality, "unmeasured");
			assert.deepEqual(reads, [target, target]);
		}
	}
});

it("preserves generic artifact reports and their identity without reading disk", () => {
	const generic = { kind: "artifact-report" } as const;
	assert.deepEqual(parseResultContract(generic, "recipe"), generic);
	assert.deepEqual(parseWorkerResultContract({ ...generic, path: undefined }, "wire"), generic);
	assert.equal(
		resultContractSourceId(generic),
		"agent-result-contract:artifact-report:8684aff02aa44364d921fc90e2188b0f1be25fea50f7e099792279cceba9d774",
	);
	assert.equal(
		resultContractShape(generic),
		"any final text; the artifact you wrote at the location the task named is the result",
	);
	for (const output of [markup, "", null]) {
		const validation = validateResultContract({
			contract: generic,
			output,
			cwd,
			networkAllowed: false,
			filesystem: {
				readFile() {
					throw new Error("unbound contract must not read disk");
				},
			},
		});
		assert.equal(validation.conformance, "pass");
		assert.equal(validation.quality, "unmeasured");
	}
});

it("admits only caller-bound relative paths and preserves source identity across JSON", () => {
	for (const artifactPath of [contract.path, "nested/page.md", "nested\\page.md", "./a page.md"]) {
		const bound = { kind: "artifact-report", path: artifactPath } as const;
		const parsed = parseWorkerResultContract(JSON.parse(JSON.stringify(bound)), "wire");
		assert.deepEqual(parsed, bound);
		assert.equal(resultContractSourceId(parsed), resultContractSourceId(bound));
		assert.throws(() => parseResultContract(bound, "recipe"), /unknown keys/u);
	}
	assert.notEqual(resultContractSourceId(contract), resultContractSourceId({ ...contract, path: "other.md" }));
	for (const artifactPath of [
		"",
		" \t",
		null,
		42,
		[],
		"a\0b",
		"/tmp/page.md",
		"../page.md",
		"a/../page.md",
		"a\\..\\page.md",
		"C:\\tmp\\page.md",
		"C:/tmp/page.md",
		"C:page.md",
		"\\\\server\\share\\page.md",
		"//server/share/page.md",
		"\\page.md",
	]) {
		assert.throws(
			() => parseWorkerResultContract({ kind: "artifact-report", path: artifactPath }, "wire"),
			/artifact-report/u,
		);
	}
	assert.throws(() => parseWorkerResultContract({ ...contract, paths: ["other.md"] }, "wire"), /only kind and path/u);
	assert.throws(() => parseResultContract({ kind: "artifact-report", path: undefined }, "recipe"), /unknown keys/u);
});

it("feeds artifact failures into paired repair feedback without inviting unavailable tools", () => {
	const validation = validateResultContract({
		contract,
		output: markup,
		cwd,
		networkAllowed: false,
		filesystem: { readFile: () => null },
	});
	assert.ok(validation.reason);
	assert.equal(RESULT_CONTRACT_REPAIR_LIMIT, 2);
	for (const toolsAvailable of [true, false, undefined]) {
		const messages = resultContractRepairMessages(
			{
				contract,
				reason: validation.reason,
				attempt: 2,
				anchors: [],
				...(toolsAvailable !== undefined ? { toolsAvailable } : {}),
			},
			{ provider: "fixture", api: "fixture", model: "fixture" },
		);
		assert.equal(messages[0].content[0].id, messages[1].toolCallId);
		assert.equal(messages[0].stopReason, "toolUse");
		const text = messages[1].content[0].text;
		assert.ok(text.includes(`Validator reason: ${validation.reason}`));
		assert.ok(text.includes(JSON.stringify(contract.path)));
		if (toolsAvailable) {
			assert.match(text, /You may use the admitted tools/u);
			assert.match(text, /Literal tool-call markup in final text does not write a file/u);
		} else {
			assert.match(text, /Tool use is over/u);
			assert.match(text, /the required artifact remains unsatisfied/u);
			assert.doesNotMatch(text, /You may use|Repair the required artifact on disk/u);
		}
	}
});
