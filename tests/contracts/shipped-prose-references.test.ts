import { doesNotMatch } from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";

function files(root: string): string[] {
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const path = join(root, entry.name);
		if (path === join("src", "interactive")) return [];
		return entry.isDirectory() ? files(path) : [path];
	});
}

it("shipped guides and core comments explain reasons without private review identifiers", () => {
	for (const path of [...files("docs"), ...files("src")].filter((path) => /\.(?:md|ts)$/.test(path))) {
		doesNotMatch(readFileSync(path, "utf8"), /BT-\d+|review round \d+|operator bootstrap report/iu, path);
	}
	doesNotMatch(
		readFileSync("docs/architecture/safety-model.md", "utf8"),
		/\n\n\n/u,
		"safety guide has no duplicate blank lines",
	);
});
