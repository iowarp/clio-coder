const separator = Deno.args.indexOf("--");
const commandArgs = separator < 0 ? Deno.args : Deno.args.slice(separator + 1);
const command = commandArgs.join("\u0000");

if (command === "paths\u0000--json") {
	console.log(JSON.stringify({
		config: "/private/researcher/.config/clio-coder",
		data: "/private/researcher/.local/share/clio-coder",
		state: "/private/researcher/.local/state/clio-coder",
		cache: "/private/researcher/.cache/clio-coder",
	}));
} else if (command === "doctor\u0000--json") {
	console.log(JSON.stringify({
		ok: false,
		fix: false,
		findings: [
			{ ok: true, name: "Clio Coder version", detail: "0.3.9" },
			{ ok: true, name: "node version", detail: "v24.9.0" },
			{ ok: true, name: "platform", detail: "linux-x64" },
			{ ok: true, name: "engine runtime", detail: "ready" },
			{ ok: true, name: "config dir", detail: "/private/researcher/.config/clio-coder" },
			{ ok: true, name: "data dir", detail: "/private/researcher/.local/share/clio-coder" },
			{ ok: true, name: "state dir", detail: "/private/researcher/.local/state/clio-coder" },
			{ ok: true, name: "cache dir", detail: "/private/researcher/.cache/clio-coder" },
			{ ok: false, name: "settings.yaml", detail: "secretToken at /private/researcher/settings.yaml is invalid" },
			{ ok: true, name: "credentials", detail: "600" },
			{ ok: true, name: "session store", detail: "/private/researcher/sessions (42 readable)" },
			{ ok: true, level: "warn", name: "target private-lab", detail: "runtime at http://10.0.0.7:1234" },
			{ ok: false, name: "model private-lab", detail: "model-secret was not advertised" },
			{ ok: true, level: "warn", name: "interop private-peer", detail: "at /private/bin/peer" },
			{ ok: true, level: "warn", name: "fleet node ssh-private", detail: "ineligible at 10.0.0.8" },
		],
	}));
	Deno.exitCode = 1;
} else Deno.exit(73);
