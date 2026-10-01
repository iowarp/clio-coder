import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	describeBashCallConsequences,
	fitConsequenceLine,
	type PathKind,
} from "../../src/domains/safety/command-consequence.js";

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
		// Round 5: here-document bodies are data, not commands.
		[
			"rm -rf build\ncat > notes.md <<EOF\nit's done\nEOF\nrm -rf ~/src",
			["Deletes build recursively", "Deletes /home/me/src recursively"],
		],
		["cat > notes.md <<'EOF'\nrm -rf /\ngit push --force\nEOF", []],
		["cat > notes.md <<'EOF'\nRun: echo x > exists.txt\nEOF", []],
		// A path with .. is never cut.
		[
			`rm -rf /home/me/projects/myapp/build/output/artifacts/${"../".repeat(7)}`,
			["Deletes a path using .. (too long to show) recursively"],
		],
		// Where `.` and the default scope are.
		["git -C /other checkout -- .", ["Discards uncommitted changes in /other"]],
		["git -C /other restore .", ["Discards uncommitted changes in /other"]],
		["git -C /other clean -fd .", ["Deletes untracked files in /other"]],
		["cd /etc && find . -delete", []],
		["cd ~ && git clean -fdx", []],
		["pkill -9 -f .", ["Stops every process you can signal (the pattern . matches all)"]],
		// ~ under another user is not this user's home.
		["doas sh -c 'rm -rf ~/.ssh'", ["Deletes ~/.ssh recursively"]],
		["kill -9 -01", ["Stops every process you can signal"]],
		["kill -9 00", ["Stops the current process group"]],
		// Abbreviated git options.
		["git push --del origin main", ["Deletes main on origin"]],
		["git push --force-w origin main", ["Publishes to origin and overwrites its history"]],
		["git push --mirr origin", ["Mirrors every ref to origin, overwriting and deleting remote refs to match"]],
		["git restore --stag f", []],
		// Words the shell fills in.
		["git push origin $':main'", ["Deletes main on origin"]],
		["rm -rf $'/'", ["Deletes / recursively"]],
		["kill -9 $'-1'", ["Stops every process you can signal"]],
		["F=--force; git push origin main $F", []],
		[
			"git reset --hard HEAD~3",
			[
				"Discards uncommitted changes in the whole working tree and moves the branch to HEAD~3, so commits after it leave the branch",
			],
		],
		// The worst step is never folded away, and wrappers do not hide a step.
		[
			"npm i left-pad; pip install six; go get example.com/x; rm -rf ~",
			[
				"Downloads packages (left-pad) and changes package.json, package-lock.json, node_modules",
				"Downloads packages (six) and changes the Python environment's site-packages",
				"Deletes /home/me recursively",
				"and 1 more",
			],
		],
		["rm -rf build && exec rm -rf ~", ["Deletes build recursively", "Deletes /home/me recursively"]],
		["timeout 60 rm -rf ~", ["Deletes /home/me recursively"]],
		["nice -n 10 rm -rf ~", ["Deletes /home/me recursively"]],
		// Overstatements.
		["cat <> exists.txt", []],
		["cp -vt dir exists.txt", []],
		["truncate -s 0 f", ["Empties f"]],
		["pip install --target d x", ["Downloads packages (x) and changes d"]],
		// Bidirectional controls are shown as text.
		["rm -rf ‮txt.exe", ["Deletes \\u{202e}txt.exe recursively"]],
	];

	for (const [command, expected] of table) {
		it(JSON.stringify(command), () => {
			deepStrictEqual(lines(command), expected);
		});
	}

	it("keeps the end of a cut sentence, and bounds a large command", () => {
		const long = `Publishes to ${"x".repeat(300)} and overwrites its history`;
		const cut = fitConsequenceLine(long);
		deepStrictEqual(
			[cut.length <= 240, cut.endsWith("and overwrites its history"), cut.includes("…")],
			[true, true, true],
		);
		deepStrictEqual(lines(`${"rm a;".repeat(100000)}rm -rf ~`).length <= 9, true);
	});

	it("describes nothing for a tool other than bash", () => {
		deepStrictEqual(describeBashCallConsequences("read", { command: "rm -rf a" }), []);
	});
});
