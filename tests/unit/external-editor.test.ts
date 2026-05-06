import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { editTextExternally, resolveExternalEditor } from "../../src/interactive/external-editor.js";

describe("interactive external editor", () => {
	it("prefers VISUAL, then EDITOR, then fallback probe", () => {
		strictEqual(
			resolveExternalEditor({ VISUAL: "code --wait", EDITOR: "vim" }, () => "nano"),
			"code --wait",
		);
		strictEqual(
			resolveExternalEditor({ EDITOR: "vim" }, () => "nano"),
			"vim",
		);
		strictEqual(
			resolveExternalEditor({}, () => "nano"),
			"nano",
		);
		strictEqual(
			resolveExternalEditor({}, () => null),
			null,
		);
	});

	it("round-trips text through the external editor command", () => {
		const script = "require('fs').writeFileSync(process.argv[1], 'edited text\\n')";
		const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;

		const result = editTextExternally("initial", command);

		strictEqual(result.ok, true, result.error);
		strictEqual(result.text, "edited text");
	});

	it("reports missing editor commands", () => {
		const result = editTextExternally("initial", null);

		strictEqual(result.ok, false);
		ok(result.error?.includes("no external editor"));
	});
});
