import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { validationContractFinding } from "../../src/cli/doctor-validation-contract.js";
import { resolveRigor, rigorResolution } from "../../src/domains/safety/rigor.js";
import {
	loadValidationContract,
	parseValidationContractText,
	VALIDATION_CONTRACT_CAPS,
} from "../../src/domains/safety/validation-contract.js";
import { discoverVerifierAuthoring } from "../../src/tools/verify/authoring.js";

/** The example contract from docs/process/scientific-validation.md, verbatim. */
const DOCUMENTED_EXAMPLE = `version: 1
task: "Regenerate the regional climate output and confirm grid metadata."
runtime:
  kind: slurm
  nodes: 4
  ranks: 64
  walltime: "01:30:00"
  modules:
    - "intel/2024"
    - "openmpi/5.0"
    - "netcdf-c/4.9"
artifacts:
  - path: out/region_west.nc
    format: NetCDF
    expected_dimensions:
      time: 8760
      lat: 360
      lon: 720
    expected_attributes:
      Conventions: "CF-1.10"
    numerical_tolerances:
      relative: 1.0e-6
    preserve: false
  - path: ckpt/run-0042.chk
    format: Checkpoint files
    preserve: true
validators:
  - "ncdump -h out/region_west.nc"
  - "python tools/check_grid.py out/region_west.nc"
notes: |
  The run is submitted with sbatch; queue exit status is not a completion check.
  Re-run check_grid.py after job completion is observed.
`;

const roots: string[] = [];

function workspace(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-validation-contract-"));
	roots.push(root);
	for (const [relative, text] of Object.entries(files)) {
		const target = join(root, relative);
		mkdirSync(join(target, ".."), { recursive: true });
		writeFileSync(target, text, "utf8");
	}
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("validation contract loader", () => {
	it("parses the documented example contract under the version-1 schema", () => {
		const root = workspace({ ".clio-coder/validation.yaml": DOCUMENTED_EXAMPLE });
		const loaded = loadValidationContract(root);
		strictEqual(loaded.ok, true);
		if (!loaded.ok || loaded.contract === null) throw new Error("expected a parsed contract");
		strictEqual(loaded.path, ".clio-coder/validation.yaml");
		deepStrictEqual(loaded.contract, {
			version: 1,
			task: "Regenerate the regional climate output and confirm grid metadata.",
			runtime: {
				kind: "slurm",
				nodes: 4,
				ranks: 64,
				walltime: "01:30:00",
				modules: ["intel/2024", "openmpi/5.0", "netcdf-c/4.9"],
			},
			artifacts: [
				{
					path: "out/region_west.nc",
					format: "NetCDF",
					expected_dimensions: { lat: 360, lon: 720, time: 8760 },
					expected_attributes: { Conventions: "CF-1.10" },
					numerical_tolerances: { relative: 1e-6 },
					preserve: false,
				},
				{ path: "ckpt/run-0042.chk", format: "Checkpoint files", preserve: true },
			],
			validators: ["ncdump -h out/region_west.nc", "python tools/check_grid.py out/region_west.nc"],
			notes:
				"The run is submitted with sbatch; queue exit status is not a completion check.\nRe-run check_grid.py after job completion is observed.\n",
		});
	});

	it("reports no contract when the workspace root has none", () => {
		deepStrictEqual(loadValidationContract(workspace({})), { ok: true, contract: null });
	});

	it("rejects an unknown field and names it", () => {
		const root = workspace({ "validation.yaml": "version: 1\nvalidatorz: []\n" });
		const loaded = loadValidationContract(root);
		strictEqual(loaded.ok, false);
		if (loaded.ok) return;
		strictEqual(loaded.path, "validation.yaml");
		match(loaded.reason, /root has unknown field\(s\): validatorz/u);
		const nested = parseValidationContractText("version: 1\nartifacts:\n  - path: out/a.nc\n    checksum: abc\n", "x");
		strictEqual(nested.ok, false);
		if (nested.ok) return;
		match(nested.reason, /artifacts\[0\] has unknown field\(s\): checksum/u);
	});

	it("rejects an over-cap file and cites the cap", () => {
		const padding = `# ${"x".repeat(VALIDATION_CONTRACT_CAPS.fileBytes)}\n`;
		const root = workspace({ "validation.yaml": `version: 1\n${padding}` });
		const loaded = loadValidationContract(root);
		strictEqual(loaded.ok, false);
		if (loaded.ok) return;
		match(loaded.reason, new RegExp(`file exceeds the ${VALIDATION_CONTRACT_CAPS.fileBytes}-byte cap`, "u"));
	});

	it("rejects an empty file, a wrong version, and a bad runtime kind", () => {
		const empty = parseValidationContractText("", "validation.yaml");
		strictEqual(empty.ok, false);
		if (!empty.ok) match(empty.reason, /root must be an object with a version field/u);
		const version = parseValidationContractText("version: 2\n", "validation.yaml");
		strictEqual(version.ok, false);
		if (!version.ok) match(version.reason, /unsupported version 2; supported version is 1/u);
		const kind = parseValidationContractText("version: 1\nruntime:\n  kind: pbs\n", "validation.yaml");
		strictEqual(kind.ok, false);
		if (!kind.ok) match(kind.reason, /root\.runtime\.kind must be one of local, slurm, mpi, other/u);
		const validators = parseValidationContractText("version: 1\nvalidators:\n  - command: ls\n", "validation.yaml");
		strictEqual(validators.ok, false);
		if (!validators.ok) match(validators.reason, /root\.validators\[0\] must be a non-empty string/u);
	});

	it("reports Markdown-only as present and advisory without parsing it", () => {
		const root = workspace({ "VALIDATION.md": "# Validate\n\nRun the grid check.\n" });
		deepStrictEqual(loadValidationContract(root), { ok: true, contract: null, path: "VALIDATION.md", advisory: true });
	});

	it("prefers the YAML contract over VALIDATION.md when both exist", () => {
		const root = workspace({ "VALIDATION.md": "prose\n", "validation.yml": "version: 1\n" });
		const loaded = loadValidationContract(root);
		strictEqual(loaded.ok, true);
		if (!loaded.ok || loaded.contract === null) throw new Error("expected the YAML contract to win");
		strictEqual(loaded.path, "validation.yml");
		deepStrictEqual(loaded.contract, { version: 1 });
	});
});

describe("rigor resolution reads the parsed contract", () => {
	it("raises rigor to high for a parsed contract and reports the source", () => {
		const root = workspace({ "validation.yaml": DOCUMENTED_EXAMPLE });
		deepStrictEqual(rigorResolution({ cwd: root, override: null }), {
			rigor: "high",
			source: "validation-contract",
			contractPath: "validation.yaml",
		});
		strictEqual(resolveRigor({ cwd: root }), "high");
	});

	it("keeps Markdown-only at normal with an advisory diagnostic", () => {
		const root = workspace({ "VALIDATION.md": "prose\n" });
		const resolution = rigorResolution({ cwd: root, override: null });
		strictEqual(resolution.rigor, "normal");
		strictEqual(resolution.source, "markdown-advisory");
		strictEqual(resolution.contractPath, "VALIDATION.md");
		match(resolution.diagnostic ?? "", /VALIDATION\.md is advisory prose and does not raise rigor/u);
		strictEqual(resolveRigor({ cwd: root }), "normal");
	});

	it("keeps an invalid contract at normal and exposes the reason", () => {
		const root = workspace({ ".clio-coder/validation.yaml": "" });
		const resolution = rigorResolution({ cwd: root, override: null });
		strictEqual(resolution.rigor, "normal");
		strictEqual(resolution.source, "invalid-contract");
		strictEqual(resolution.contractPath, ".clio-coder/validation.yaml");
		match(resolution.diagnostic ?? "", /^\.clio-coder\/validation\.yaml: root must be an object with a version field/u);
		strictEqual(resolveRigor({ cwd: root }), "normal");
	});

	it("resolves to none with no contract and lets an override win in both directions", () => {
		const empty = workspace({});
		deepStrictEqual(rigorResolution({ cwd: empty, override: null }), { rigor: "normal", source: "none" });
		deepStrictEqual(rigorResolution({ cwd: empty, override: "high" }), { rigor: "high", source: "override" });
		const parsed = workspace({ "validation.yaml": "version: 1\n" });
		deepStrictEqual(rigorResolution({ cwd: parsed, override: "normal" }), { rigor: "normal", source: "override" });
	});
});

describe("doctor reports the validation contract", () => {
	it("gives one row per state", () => {
		const none = validationContractFinding(workspace({}));
		strictEqual(none.ok, true);
		match(none.detail, /^none at the workspace root/u);
		const valid = validationContractFinding(workspace({ "validation.yaml": DOCUMENTED_EXAMPLE }));
		strictEqual(valid.ok, true);
		match(
			valid.detail,
			/^valid: validation\.yaml \(version 1, 2 artifact\(s\), 2 validator\(s\)\); rigor default high$/u,
		);
		const markdown = validationContractFinding(workspace({ "VALIDATION.md": "prose\n" }));
		strictEqual(markdown.ok, true);
		strictEqual(markdown.level, "warn");
		match(markdown.detail, /^markdown-only: VALIDATION\.md is advisory prose/u);
		const invalid = validationContractFinding(workspace({ "validation.yaml": "version: 1\nextra: 1\n" }));
		strictEqual(invalid.ok, false);
		match(invalid.detail, /^invalid: validation\.yaml: root has unknown field\(s\): extra; rigor default stays normal$/u);
	});
});

describe("verifier authoring reads validators through the loader", () => {
	it("proposes the same checks for the documented example contract", () => {
		const root = workspace({ "validation.yaml": DOCUMENTED_EXAMPLE });
		const discovery = discoverVerifierAuthoring(root);
		strictEqual(discovery.ok, true);
		if (!discovery.ok) return;
		deepStrictEqual(discovery.diagnostics, []);
		deepStrictEqual(discovery.proposals, [
			{
				id: "validation-check_grid",
				description: 'Run validation contract command ["python","tools/check_grid.py","out/region_west.nc"]',
				command: ["python", "tools/check_grid.py", "out/region_west.nc"],
				cwd: ".",
				timeoutMs: 120000,
				tags: ["scientific", "validation"],
				provenance: {
					kind: "validation-contract",
					path: "validation.yaml",
					detail: "validators[1]",
					authority: "project-declared",
				},
				state: "proposed",
			},
			{
				id: "validation-ncdump",
				description: 'Run validation contract command ["ncdump","-h","out/region_west.nc"]',
				command: ["ncdump", "-h", "out/region_west.nc"],
				cwd: ".",
				timeoutMs: 120000,
				tags: ["scientific", "validation"],
				provenance: {
					kind: "validation-contract",
					path: "validation.yaml",
					detail: "validators[0]",
					authority: "project-declared",
				},
				state: "proposed",
			},
		]);
	});

	it("skips discovery with the loader's reason when the contract is invalid", () => {
		const root = workspace({ "validation.yaml": "version: 1\nvalidators: [ls]\nbogus: true\n" });
		const discovery = discoverVerifierAuthoring(root);
		strictEqual(discovery.ok, true);
		if (!discovery.ok) return;
		deepStrictEqual(discovery.proposals, []);
		ok(
			discovery.diagnostics.some((line) =>
				line.startsWith("validation.yaml: root has unknown field(s): bogus; validation command discovery skipped."),
			),
			discovery.diagnostics.join("\n"),
		);
	});
});
