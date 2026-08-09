import { strictEqual } from "node:assert/strict";
import { execSync } from "node:child_process";
import { describe, it } from "node:test";

export function findUnnecessaryExportsInArea(area: string): string[] {
	const cmd = `grep -rhoE "^export (async )?function ([A-Za-z0-9_]+)" ${area} --include=*.ts | awk '{print $NF}' | sort -u`;
	let symbolsStr = "";
	try {
		symbolsStr = execSync(cmd, { encoding: "utf-8" }).trim();
	} catch {
		return [];
	}
	if (!symbolsStr) return [];
	const symbols = symbolsStr.split("\n").filter(Boolean);
	const dead: string[] = [];
	for (const sym of symbols) {
		const files = execSync(`grep -rlw "${sym}" src/ tests/ apps/ --include=*.ts --include=*.mjs 2>/dev/null || true`, {
			encoding: "utf-8",
		}).trim();
		if (files.split("\n").filter(Boolean).length === 1) {
			dead.push(sym);
		}
	}
	return dead;
}

describe("export hygiene contract", () => {
	const sweptAreas = ["src/entry", "src/cli", "src/core"];

	for (const area of sweptAreas) {
		it(`has no unnecessary export keywords in ${area}`, () => {
			const dead = findUnnecessaryExportsInArea(area);
			strictEqual(dead.length, 0, `Unnecessary export keywords in ${area}: ${dead.join(", ")}`);
		});
	}
});
