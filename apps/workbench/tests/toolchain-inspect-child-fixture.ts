const separator = Deno.args.indexOf("--");
const commandArgs = separator < 0 ? Deno.args : Deno.args.slice(separator + 1);
if (commandArgs.join("\u0000") !== "tools\u0000list\u0000--json") Deno.exit(73);

console.log(JSON.stringify([
	{
		id: "herdr",
		version: "0.8.2",
		license: "Apache-2.0",
		platform: "linux-x64",
		supported: true,
		installed: true,
		installDir: "/native/private/tools/herdr/0.8.2",
		source: "vendored",
		binaryPath: "/native/private/tools/herdr/0.8.2/herdr",
		foundVersion: "0.8.2",
		minimumVersion: "0.8.2",
		pathCandidate: {
			path: "/native/private/bin/herdr",
			version: "0.7.5",
			satisfiesMinimum: false,
		},
		detail: "vendored private binary; rejected a private PATH candidate",
	},
	{
		id: "yazi",
		version: "26.8.15",
		license: "MIT",
		platform: "linux-x64",
		supported: true,
		installed: false,
		installDir: "/native/private/tools/yazi/26.8.15",
		source: "none",
		binaryPath: null,
		foundVersion: null,
		minimumVersion: "26.8.15",
		pathCandidate: null,
		detail: "not found",
	},
]));
