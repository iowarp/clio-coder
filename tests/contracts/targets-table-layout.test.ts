/**
 * `clio-coder targets --probe` wrote nine fixed-width columns summing to 164, so it
 * emitted 141 to 195 column rows into whatever terminal it was given and the
 * shell wrapped every one of them. The cut was the worse half: each cell was
 * sliced to its fixed width with no mark, so a target id longer than 13
 * characters printed as a prefix that reads like an id, is not one, and cannot
 * be pasted back into `clio-coder targets use`.
 *
 * The width the layout is given is the width it must respect. These cases pin
 * containment first, then the two properties the cut has to keep: ids survive
 * whole, and anything shortened says so.
 */
import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { formatTargetTable, type TargetTableRow } from "../../src/cli/targets.js";
import { terminalColumns } from "../../src/cli/text-layout.js";

/** Every size in the release width matrix that a plain-stdout surface can see. */
const WIDTHS = [80, 100, 120, 160, 220];
const DEGRADED_REASON = "default model 'qwen3.8-27b-zbook' is not advertised by the target";

/** Ids, urls, and model names at the lengths real targets carry them. */
const ROWS: ReadonlyArray<TargetTableRow> = [
	{
		id: "local-lmstudio-workstation",
		tier: "local-native",
		runtime: "lmstudio",
		auth: "none",
		url: "http://localhost:1234/v1/openai/compat",
		model: "qwen3-coder-30b-a3b-instruct-mlx@8bit",
		health: "healthy",
		caps: "CTR-E--",
		notes: "ctx 262144 resident: qwen3-coder-30b-a3b-instruct-mlx@8bit",
	},
	{
		id: "anthropic",
		tier: "cloud",
		runtime: "anthropic",
		auth: "env:ANTHROPIC_API_KEY",
		url: "(built-in)",
		model: "claude-opus-4-5",
		health: "unknown",
		caps: "CTRV---",
		notes: "ctx 200000 (unverified runtime default)",
	},
];

describe("contracts/targets table layout", () => {
	it("keeps every probe row inside the terminal at every matrix width", () => {
		for (const width of WIDTHS) {
			const table = formatTargetTable(ROWS, width);
			ok(
				table.header.length <= width,
				`width ${width} produced a ${table.header.length}-column header: ${JSON.stringify(table.header)}`,
			);
			for (const row of table.rows) {
				ok(row.length <= width, `width ${width} produced a ${row.length}-column row: ${JSON.stringify(row)}`);
			}
			for (const details of table.details) {
				for (const detail of details) {
					ok(detail.length <= width, `width ${width} produced a ${detail.length}-column detail: ${JSON.stringify(detail)}`);
				}
			}
		}
	});

	it("prints the full degraded reason below plain and gateway rows at 80 and 120 columns", () => {
		const degradedRows: ReadonlyArray<TargetTableRow> = [
			{
				...(ROWS[0] as TargetTableRow),
				id: "zbook",
				model: "qwen3.8-27b-zbook",
				health: "degraded",
				notes: `${DEGRADED_REASON} ctx 262144 resident: qwen3.8-27b`,
				diagnostic: DEGRADED_REASON,
			},
			{
				...(ROWS[0] as TargetTableRow),
				id: "dynamo",
				model: "qwen3.8-27b-dynamo",
				health: "degraded",
				notes: `${DEGRADED_REASON} gateway ctx 262144 resident: qwen3.8-27b`,
				diagnostic: DEGRADED_REASON,
			},
		];
		for (const columns of ["80", "120"]) {
			const width = terminalColumns({}, { COLUMNS: columns });
			const table = formatTargetTable(degradedRows, width);
			for (const [index, details] of table.details.entries()) {
				ok(details.length > 0, `width ${width} dropped the detail for ${degradedRows[index]?.id}`);
				strictEqual(
					details.join(" ").trim(),
					`reason: ${DEGRADED_REASON}`,
					`width ${width} did not preserve the full reason for ${degradedRows[index]?.id}`,
				);
			}
		}
	});

	it("prints every id whole, because a cut id is not an id", () => {
		for (const width of WIDTHS) {
			for (const [index, row] of formatTargetTable(ROWS, width).rows.entries()) {
				const id = ROWS[index]?.id ?? "";
				ok(row.startsWith(id), `width ${width} row ${index} does not open with ${id}: ${JSON.stringify(row)}`);
			}
		}
	});

	it("marks a url or model it had to cut", () => {
		// 100 columns cannot hold both identity columns whole, so both are cut and
		// both have to say so rather than reading as a shorter real value.
		const [first = ""] = formatTargetTable(ROWS, 100).rows;
		const cells = first.split(/\s+/u);
		const url = cells.find((cell) => cell.startsWith("http://"));
		const model = cells.find((cell) => cell.startsWith("qwen3-coder"));
		ok(url?.endsWith("…"), `expected a cut mark on the url, got ${JSON.stringify(url)}`);
		ok(model?.endsWith("…"), `expected a cut mark on the model, got ${JSON.stringify(model)}`);
		ok(!url?.includes("compat"), "the cut url is not the whole url");
	});

	/**
	 * Shrinking until the row happened to fit stopped at the wrong place: at 120
	 * columns url and model were already at their 12-column floors while auth,
	 * runtime, and tier had not been asked for anything, so four targets on four
	 * different hosts all printed `http://127.…`. A url that cannot be told from
	 * the next url is not a url.
	 */
	it("spends width above the minimum layout on url and model, so hosts stay distinguishable", () => {
		const hosts: ReadonlyArray<TargetTableRow> = [
			{ ...(ROWS[0] as TargetTableRow), id: "local-a", url: "http://127.0.0.11:1234/v1" },
			{ ...(ROWS[0] as TargetTableRow), id: "local-b", url: "http://127.0.0.22:11434" },
			{ ...(ROWS[0] as TargetTableRow), id: "local-c", url: "http://127.0.0.33:8080" },
			{ ...(ROWS[0] as TargetTableRow), id: "local-d", url: "http://127.0.0.44:8000" },
		];
		const urls = formatTargetTable(hosts, 120).rows.map((row) =>
			row.split(/\s+/u).find((cell) => cell.startsWith("http")),
		);
		strictEqual(
			new Set(urls).size,
			hosts.length,
			`four hosts rendered as ${urls.length - new Set(urls).size + 1}: ${urls.join(" ")}`,
		);
	});

	it("keeps the columns aligned across rows", () => {
		const table = formatTargetTable(ROWS, 160);
		const [first = "", second = ""] = table.rows;
		// Same offset for the runtime cell on both rows is the property the fixed
		// widths were reaching for and lost as soon as an id overran.
		const runtimeOffset = first.indexOf("lmstudio", ROWS[0]?.id.length ?? 0);
		strictEqual(runtimeOffset, second.indexOf("anthropic", 1));
		strictEqual(table.header.indexOf("runtime"), runtimeOffset);
	});
});
