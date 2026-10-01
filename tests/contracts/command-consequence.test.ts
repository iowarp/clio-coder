import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { describeBashCallConsequences, type PathKind } from "../../src/domains/safety/command-consequence.js";

const EXISTING: Readonly<Record<string, PathKind>> = {
	"exists.txt": "file",
	"/home/me/.bashrc": "file",
};
const pathKind = (path: string): PathKind => EXISTING[path] ?? null;
const OPTIONS = { pathKind, home: "/home/me" };

function lines(command: string): string[] {
	return describeBashCallConsequences("bash", { command }, OPTIONS);
}

describe("bash approval card consequence lines", () => {
	const table: ReadonlyArray<readonly [command: string, expected: string[]]> = [
		// Every step of a multi-line command, not the first.
		["rm -rf a\nrm -rf b", ["Deletes a recursively", "Deletes b recursively"]],
		["git status\nrm -rf build", ["Deletes build recursively"]],
		// kill with a negative pid or a process group.
		["kill -9 -1", ["Stops every process you can signal"]],
		["kill -KILL -1", ["Stops every process you can signal"]],
		["kill -- -1", ["Stops every process you can signal"]],
		["kill -9 -1234", ["Stops process group 1234"]],
		["kill -HUP 12", ["Signals processes 12"]],
		["kill -0 -1", []],
		// git push refspecs.
		["git push origin :branch", ["Deletes branch on origin"]],
		["git push origin --delete branch", ["Deletes branch on origin"]],
		["git push origin +main", ["Publishes to origin and overwrites its history"]],
		["git push --mirror origin", ["Mirrors every ref to origin, overwriting and deleting remote refs to match"]],
		["git push origin main", ["Publishes to origin"]],
		// Overwrites need an existing file, a resolvable path, and no cd before it.
		["cp a.txt exists.txt", ["Overwrites exists.txt"]],
		["cd sub && cp a.txt exists.txt", []],
		["echo hi > ~/.bashrc", ["Overwrites /home/me/.bashrc"]],
		["echo hi > $HOME/.bashrc", ["Overwrites /home/me/.bashrc"]],
		["echo hi > '$HOME/.bashrc'", []],
		["echo hi > $OTHER/exists.txt", []],
		["echo hi > fresh.txt", []],
		// Package managers.
		["pnpm -w add foo", ["Downloads packages (foo) and changes package.json, pnpm-lock.yaml, node_modules"]],
		["pnpm add -w foo", ["Downloads packages (foo) and changes package.json, pnpm-lock.yaml, node_modules"]],
		["yarn", ["Downloads packages and changes yarn.lock, node_modules"]],
		[
			"pip install --index-url https://example.org/simple foo",
			["Downloads packages (foo) and changes the Python environment's site-packages"],
		],
		// Discards, deletes and scope wording.
		["git restore -p a.ts", ["Discards uncommitted changes in a.ts"]],
		["git clean -fd", ["Deletes untracked files in the current directory"]],
		["git checkout .", ["Discards uncommitted changes in the current directory"]],
		["git reset --hard", ["Discards uncommitted changes in the whole working tree"]],
		["find . -name '*.o' -delete", ["Deletes what find matches under the current directory"]],
		["ls | xargs rm -rf", ["Deletes the paths xargs reads recursively"]],
		["pkill -u me", ["Stops processes owned by me"]],
		// Bidirectional controls are shown as text.
		["rm -rf ‮txt.exe", ["Deletes \\u{202e}txt.exe recursively"]],
	];

	for (const [command, expected] of table) {
		it(JSON.stringify(command), () => {
			deepStrictEqual(lines(command), expected);
		});
	}

	it("describes nothing for a tool other than bash", () => {
		deepStrictEqual(describeBashCallConsequences("read", { command: "rm -rf a" }), []);
	});
});
