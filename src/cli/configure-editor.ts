import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { SettingsValidationError, settingsPath, validateSettings, withSettingsLock } from "../core/config.js";
import { DEFAULT_SETTINGS_YAML } from "../core/defaults.js";
import { editTextExternally, resolveExternalEditor } from "../core/external-editor.js";
import { safeResourceWrite } from "../core/safe-resource-write.js";
import type { ConfigurePrompts } from "./configure-prompts.js";

/** Edit a draft, validate it, then replace the file only if it has not changed meanwhile. */
export async function editSettings(prompts: ConfigurePrompts): Promise<boolean> {
	const file = settingsPath();
	const original = existsSync(file) ? readFileSync(file, "utf8") : null;
	let draft = original ?? DEFAULT_SETTINGS_YAML;
	const editor = resolveExternalEditor();
	for (;;) {
		const result = editTextExternally(draft, editor, ".yaml");
		if (!result.ok || result.text === undefined) throw new Error(result.error ?? "Editor did not return a draft");
		draft = `${result.text}\n`;
		if (draft === original) {
			prompts.output.write("Settings unchanged.\n");
			return false;
		}
		try {
			const validated = validateSettings(parse(draft));
			if (validated.issues.length) throw new SettingsValidationError(validated.issues);
		} catch (error) {
			prompts.output.write(`${error instanceof Error ? error.message : String(error)}\n`);
			if (
				(await prompts.choose("Invalid draft", ["Return to editor", "Discard draft"], "Return to editor")) ===
				"Return to editor"
			)
				continue;
			return false;
		}
		const choice = await prompts.choose(
			"Save validated settings?",
			["Save", "Return to editor", "Discard draft"],
			"Save",
		);
		if (choice === "Return to editor") continue;
		if (choice !== "Save") return false;
		withSettingsLock(() => {
			const current = existsSync(file) ? readFileSync(file, "utf8") : null;
			if (current !== original)
				throw new Error("Settings changed while the editor was open. Reopen the editor to keep those changes.");
			safeResourceWrite(file, draft, { encoding: "utf8", mode: 0o644, backup: original !== null });
		});
		prompts.output.write(`Settings saved to ${file}${original === null ? "" : `; previous file: ${file}.bak`}\n`);
		return true;
	}
}
