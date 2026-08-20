import { ok, rejects, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, it } from "node:test";
import { runContextClear } from "../../src/domains/context/clear.js";
import { codewikiPath, readCodewiki } from "../../src/domains/context/codewiki/artifact.js";
import {
	coordinateCodewikiExclusive,
	coordinateCodewikiWrite,
} from "../../src/domains/context/codewiki/coordinator.js";

interface Deferred {
	promise: Promise<void>;
	resolve(): void;
}

function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function hasSymbol(cwd: string, name: string): boolean {
	return readCodewiki(cwd)?.symbols.some((symbol) => symbol.name === name) === true;
}

describe("contracts/codewiki coordinator", { concurrency: false }, () => {
	const scratch: string[] = [];
	afterEach(() => {
		for (const cwd of scratch.splice(0)) rmSync(cwd, { recursive: true, force: true });
	});

	function project(): string {
		const cwd = mkdtempSync(join(tmpdir(), "clio-codewiki-coordinator-"));
		scratch.push(cwd);
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "first.ts"), "export const firstGeneration = true;\n", "utf8");
		return cwd;
	}

	it("canonicalizes workspace aliases and queues changes against the committed generation", async () => {
		const cwd = project();
		const committing = deferred();
		const release = deferred();
		const first = coordinateCodewikiWrite(cwd, () => ({ kind: "build", cwd, language: "typescript" }), {
			beforeCommit: async () => {
				committing.resolve();
				await release.promise;
			},
		});
		await committing.promise;

		writeFileSync(join(cwd, "src", "second.ts"), "export const secondGeneration = true;\n", "utf8");
		const second = coordinateCodewikiWrite(relative(process.cwd(), cwd), (current) => {
			ok(current, "the incremental generation must re-read the first committed artifact");
			return { kind: "incremental", cwd, current, paths: ["src/second.ts"] };
		});
		release.resolve();
		await Promise.all([first, second]);

		ok(hasSymbol(cwd, "firstGeneration"));
		ok(hasSymbol(cwd, "secondGeneration"));
	});

	it("orders reset after an admitted build so the old build cannot resurrect the artifact", async () => {
		const cwd = project();
		const committing = deferred();
		const release = deferred();
		const build = coordinateCodewikiWrite(cwd, () => ({ kind: "build", cwd, language: "typescript" }), {
			beforeCommit: async () => {
				committing.resolve();
				await release.promise;
			},
		});
		await committing.promise;
		const clear = runContextClear({ cwd, confirmContext: () => true });
		release.resolve();
		await Promise.all([build, clear]);
		strictEqual(existsSync(codewikiPath(cwd)), false);
	});

	it("releases both the in-process lane and file lease after a failed commit", async () => {
		const cwd = project();
		await rejects(
			coordinateCodewikiWrite(cwd, () => ({ kind: "build", cwd, language: "typescript" }), {
				beforeCommit: () => {
					throw new Error("adversarial commit failure");
				},
			}),
			/adversarial commit failure/,
		);
		strictEqual(existsSync(codewikiPath(cwd)), false);
		const recovered = await coordinateCodewikiWrite(cwd, () => ({ kind: "build", cwd, language: "typescript" }));
		ok(recovered);
		ok(hasSymbol(cwd, "firstGeneration"));

		await coordinateCodewikiExclusive(cwd, () => undefined);
	});
});
