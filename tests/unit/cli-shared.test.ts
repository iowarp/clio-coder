import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { extractApiKeyFlag, extractNoContextFilesFlag } from "../../src/cli/shared.js";

describe("cli/shared extractApiKeyFlag", () => {
	it("returns the original argv unchanged when --api-key is absent", () => {
		const argv = ["doctor", "--fix"];
		const out = extractApiKeyFlag(argv);
		deepStrictEqual(out, { rest: ["doctor", "--fix"] });
	});

	it("consumes --api-key and its value when before the first subcommand", () => {
		const argv = ["--api-key", "sk-test", "doctor"];
		const out = extractApiKeyFlag(argv);
		deepStrictEqual(out, { apiKey: "sk-test", rest: ["doctor"] });
	});

	it("leaves --api-key after the first subcommand in rest", () => {
		const argv = ["auth", "login", "openai", "--api-key", "sk-test"];
		const out = extractApiKeyFlag(argv);
		deepStrictEqual(out, { rest: ["auth", "login", "openai", "--api-key", "sk-test"] });
	});
});

describe("cli/shared extractNoContextFilesFlag", () => {
	it("returns noContextFiles=false when the flag is absent", () => {
		const argv = ["doctor", "--fix"];
		const out = extractNoContextFilesFlag(argv);
		strictEqual(out.noContextFiles, false);
		deepStrictEqual(out.rest, ["doctor", "--fix"]);
	});

	it("consumes --no-context-files when before the first subcommand", () => {
		const argv = ["--no-context-files", "run", "hello"];
		const out = extractNoContextFilesFlag(argv);
		strictEqual(out.noContextFiles, true);
		deepStrictEqual(out.rest, ["run", "hello"]);
	});

	it("consumes the -nc alias when before the first subcommand", () => {
		const argv = ["-nc", "run", "hello"];
		const out = extractNoContextFilesFlag(argv);
		strictEqual(out.noContextFiles, true);
		deepStrictEqual(out.rest, ["run", "hello"]);
	});

	it("leaves --no-context-files after the first subcommand in rest", () => {
		const argv = ["run", "--no-context-files", "hello"];
		const out = extractNoContextFilesFlag(argv);
		strictEqual(out.noContextFiles, false);
		deepStrictEqual(out.rest, ["run", "--no-context-files", "hello"]);
	});

	it("leaves -nc after the first subcommand in rest", () => {
		const argv = ["run", "-nc", "hello"];
		const out = extractNoContextFilesFlag(argv);
		strictEqual(out.noContextFiles, false);
		deepStrictEqual(out.rest, ["run", "-nc", "hello"]);
	});

	it("co-exists with --api-key extraction in either order", () => {
		const a = extractNoContextFilesFlag(extractApiKeyFlag(["--api-key", "sk", "--no-context-files", "doctor"]).rest);
		strictEqual(a.noContextFiles, true);
		deepStrictEqual(a.rest, ["doctor"]);

		const b = extractApiKeyFlag(extractNoContextFilesFlag(["--no-context-files", "--api-key", "sk", "doctor"]).rest);
		deepStrictEqual(b, { apiKey: "sk", rest: ["doctor"] });
	});
});
