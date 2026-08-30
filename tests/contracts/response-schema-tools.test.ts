import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	assertValidResponseSchema,
	isResponseSchemaRejection,
	responseSchemaConflictsWithTools,
	responseSchemaDialectFor,
	runtimeSpeaksResponseSchemaDialect,
} from "../../src/core/response-schema.js";
import { HANDOFF_RESPONSE_SCHEMA } from "../../src/domains/session/handoff.js";
import { patchResponseSchemaPayloadForDialect } from "../../src/engine/provider-payload.js";

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
			responseSchemaConflictsWithTools({ id: "lmstudio", kind: "http", apiFamily: "openai-completions" }, 4),
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

/**
 * The `/handoff` extraction round asked for a schema in prose and bound
 * nothing, so it worked on a capable cloud model and refused on a local one
 * with "the extraction round returned no JSON object" (issue #223). The
 * out-of-turn seam now looks the runtime's own spelling up and constrains the
 * request where there is one, while the worker seam keeps its stricter check:
 * a worker that cannot enforce a contract refuses admission rather than
 * degrading, and an out-of-turn round degrades rather than refusing.
 */
describe("contracts/response-schema/out-of-turn dialects", () => {
	it("names a dialect for each runtime that has one, and none for the rest", () => {
		strictEqual(responseSchemaDialectFor("llamacpp"), "llamacpp-json-object");
		strictEqual(responseSchemaDialectFor("lmstudio"), "openai-json-schema");
		strictEqual(responseSchemaDialectFor("openai"), null, "a runtime with no known spelling gets no constraint");
		strictEqual(responseSchemaDialectFor("vllm"), null);
		strictEqual(responseSchemaDialectFor("anthropic"), null);
	});

	/**
	 * The two spellings are not interchangeable. llama-server compiles
	 * `response_format.schema` into a sampler grammar and ignores the newer
	 * discriminator; the OpenAI form nests the schema under `json_schema` with a
	 * name. Sending either to the other server is a silent non-enforcement, which
	 * is why the table is keyed by runtime id rather than by capability flag.
	 */
	it("sends each runtime the spelling it actually implements", () => {
		const schema = { type: "object", properties: { a: { type: "string" } } };
		const llama = patchResponseSchemaPayloadForDialect({ model: "m" }, "llamacpp-json-object", schema, "record") as {
			model: string;
			response_format: { type: string; schema: unknown; json_schema?: unknown };
		};
		strictEqual(llama.model, "m", "the rest of the payload is untouched");
		strictEqual(llama.response_format.type, "json_object");
		deepStrictEqual(llama.response_format.schema, schema);
		strictEqual(llama.response_format.json_schema, undefined);

		const openai = patchResponseSchemaPayloadForDialect({ model: "m" }, "openai-json-schema", schema, "record") as {
			response_format: { type: string; schema?: unknown; json_schema: { name: string; strict: boolean; schema: unknown } };
		};
		strictEqual(openai.response_format.type, "json_schema");
		strictEqual(openai.response_format.json_schema.name, "record");
		strictEqual(openai.response_format.json_schema.strict, true);
		deepStrictEqual(openai.response_format.json_schema.schema, schema);
		strictEqual(openai.response_format.schema, undefined);
	});

	it("leaves a payload it cannot patch alone rather than replacing it", () => {
		strictEqual(patchResponseSchemaPayloadForDialect("not-an-object", "llamacpp-json-object", {}, "record"), undefined);
		strictEqual(patchResponseSchemaPayloadForDialect(null, "openai-json-schema", {}, "record"), undefined);
	});

	/** The schema the round binds has to survive the enforceable-subset check. */
	it("keeps the handoff schema inside the enforceable subset", () => {
		assertValidResponseSchema(HANDOFF_RESPONSE_SCHEMA, "HANDOFF_RESPONSE_SCHEMA");
	});
});
