import { defineCommandSpec } from "../kit/help.js";

export const spec = defineCommandSpec({
	path: ["config"],
	summary:
		"inspect effective customization; get, set or unset one setting; review or approve project safety, hooks, settings, extensions, or plugins",
	hidden: false,
});

export const leafSpecs = [
	defineCommandSpec({ path: ["config", "inspect"], summary: "print the effective-customization graph", hidden: false }),
	defineCommandSpec({
		path: ["config", "get"],
		summary: "print one setting's value and the layer it came from",
		hidden: false,
	}),
	defineCommandSpec({
		path: ["config", "set"],
		summary: "save one setting in the user or project scope",
		hidden: false,
	}),
	defineCommandSpec({
		path: ["config", "unset"],
		summary: "remove one setting from the user or project scope",
		hidden: false,
	}),
	defineCommandSpec({ path: ["config", "trust"], summary: "review or approve a project surface", hidden: false }),
] as const;

export const CONFIG_HELP = `clio-coder config inspect [--json]
clio-coder config get <path> [--scope effective|user|project] [--json]
clio-coder config set <path> <value> [--scope user|project] [--json]
clio-coder config unset <path> [--scope user|project] [--json]
clio-coder config trust safety|hooks|settings|extensions|plugins|handbook [--json | --hash SHA256 | --revoke]

inspect (the default) prints the effective-customization graph: what settings, context
files, rules, skills, prompts, agents, playbooks, extensions, safety, memory, hooks, and
the operator profile loaded, from where, with what precedence, trust, reload class, and
context cost. Read-only; nothing is created.

This is the "why is CLIO Coder behaving this way" surface. Parse the --json form
in scripts instead of the table.

get, set and unset address one setting by its dotted path, such as
interface.exitSummary. See clio-coder config set --help for the paths it accepts.

Trust previews show the captured project files and their digest. Approve only
the reviewed digest with --hash, or remove a surface's approval with --revoke.
Settings and safety reload on restart; project hooks also check trust before execution.
Project extensions and plugins load only after their surface is approved; approve, then
reload extensions or the library.
`;

export const CONFIG_GET_HELP = `clio-coder config get <path> [--scope effective|user|project] [--json]

Print one setting by its dotted path, such as interface.exitSummary.

  --scope effective   the layered value and the layer it came from (default):
                      default, user, project or project.local
  --scope user        the value saved in your user settings.yaml
  --scope project     the value saved in this project's .clio-coder/settings.local.yaml
                      or .clio-coder/settings.yaml, trusted or not
  --json              one JSON object: version, path, scope, value, source, file

A user or project scope that does not set the path exits 1 (not_found).
A path that is not a setting exits 2.
`;

export const CONFIG_SET_HELP = `clio-coder config set <path> <value> [--scope user|project] [--json]

Save one setting. The path is a settings control, the same ones /settings and
clio-coder configure --settings edit, such as interface.exitSummary. The value is
parsed by the setting's type: one of the listed choices, true or false, a number,
text, or null where the setting may be left unset. A negative number follows --,
as in: clio-coder config set <path> -- -1

  --scope user      your user settings.yaml (default); saved under the settings lock,
                    so a concurrent edit to another key is kept
  --scope project   this project's .clio-coder/settings.local.yaml; the project
                    settings must already be trusted (clio-coder config trust settings),
                    and the bytes written are approved
  --json            one JSON object: version, path, scope, value, file

Routing (chat.target, chat.model, fleet.*, context.memory.target,
context.memory.model, targets) is refused: use clio-coder targets use, clio-coder
targets profile, or clio-coder configure. List and structured settings are edited
with clio-coder configure --settings or in the settings file.

An unknown path or an invalid value exits 2 and writes nothing.
`;

export const CONFIG_UNSET_HELP = `clio-coder config unset <path> [--scope user|project] [--json]

Remove one setting from that scope's saved file, so the effective value falls
back to the next layer or the shipped default.

  --scope user      your user settings.yaml (default)
  --scope project   this project's .clio-coder/settings.local.yaml; the project
                    settings must already be trusted
  --json            one JSON object: version, path, scope, removed, file

A path the scope's file does not set exits 1 (not_found) and writes nothing.
`;
