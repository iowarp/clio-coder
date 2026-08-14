import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	isResponseSchemaRejection,
	responseSchemaConflictsWithTools,
	runtimeSpeaksResponseSchemaDialect,
} from "../../src/core/response-schema.js";

const LLAMACPP = { id: "llamacpp", kind: "http", apiFamily: "openai-completions" };

describe("contracts/response-schema/tool-grammar-conflict", () => {
	/**
	 * `runtimeSpeaksResponseSchemaDialect` answers "can this runtime carry a
	 * schema at all", which is the wrong question for a run that also carries
	 * tools. Direct curls against llama-server established that schema alone
	 * succeeds and schema plus one tool answers 400 before generating a token, so
	 * the conflict is a second fact about the same dialect that no capability
	 * probe reports.
	 */
	it("separates the tool-free schema request from the one llama-server refuses", () => {
		ok(runtimeSpeaksResponseSchemaDialect(LLAMACPP));
		strictEqual(responseSchemaConflictsWithTools(LLAMACPP, 0), false);
		ok(responseSchemaConflictsWithTools(LLAMACPP, 1));
		ok(responseSchemaConflictsWithTools(LLAMACPP, 12));
	});

	/**
	 * A runtime that does not speak the dialect never reaches this question: the
	 * admission check refuses its schema one clause earlier. Answering false here
	 * keeps the predicate from reading as a general claim about tool grammars.
	 */
	it("claims nothing about runtimes outside the dialect", () => {
		strictEqual(
			responseSchemaConflictsWithTools({ id: "lmstudio-native", kind: "http", apiFamily: "lmstudio-native" }, 4),
			false,
		);
		strictEqual(
			responseSchemaConflictsWithTools({ id: "vllm", kind: "http", apiFamily: "openai-completions" }, 4),
			false,
		);
		strictEqual(
			responseSchemaConflictsWithTools({ id: "llamacpp", kind: "sdk", apiFamily: "openai-completions" }, 4),
			false,
		);
	});

	/**
	 * The predicate exists to pre-empt a specific mid-run failure. That failure
	 * stays recognized for every caller that has not asked the question up front,
	 * so arming the predicate never disarms the fallback behind it.
	 */
	it("leaves the mid-run rejection recognizer intact", () => {
		ok(isResponseSchemaRejection("HTTP 400: Failed to initialize samplers: failed to parse grammar"));
		strictEqual(isResponseSchemaRejection("HTTP 500: internal server error"), false);
		strictEqual(isResponseSchemaRejection(null), false);
	});
});
