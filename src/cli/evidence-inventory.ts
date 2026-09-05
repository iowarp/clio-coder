import { evidenceInventorySnapshot } from "../domains/evidence/inventory.js";

export * from "../domains/evidence/inventory.js";

/**
 * `clio-coder evidence inventory --json`, and nothing else.
 *
 * `fixed` is false as soon as the caller supplied an id or any other argument.
 * A GUI host invokes this knowing the process it started cannot be steered into
 * reading a different bundle or a wider window.
 */
export async function runEvidenceInventory(fixed: boolean): Promise<number> {
	if (!fixed) {
		process.stderr.write("clio-coder evidence inventory: usage: clio-coder evidence inventory --json\n");
		return 2;
	}
	process.stdout.write(`${JSON.stringify(await evidenceInventorySnapshot(), null, 2)}\n`);
	return 0;
}
