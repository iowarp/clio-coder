import type { PinnedTool, ToolPlatform } from "./types.js";

/**
 * The pinned table.
 *
 * Every checksum here was computed from the asset as downloaded from the URL
 * beside it, not copied from a release note. Where upstream publishes its own
 * checksum file the two were compared and agree; where upstream publishes no
 * checksums, only the platform whose asset was actually fetched and hashed is
 * listed, because a hash nobody verified is worse than a missing platform: it
 * turns an honest "no asset for your platform" into a failed install that
 * looks like tampering.
 *
 * Bumping a version means re-downloading each listed asset and re-computing
 * each hash. The registry-shape contract test refuses an entry that carries a
 * platform without a checksum. A bump also supersedes whatever version the
 * machine already has, and the installer prunes it, so a tool holds exactly one
 * version directory.
 *
 * `minimumVersion` is the floor a copy already on PATH has to clear. A floor
 * moves on evidence and on nothing else: name the older release, say which of
 * its surfaces you exercised and how, and put that in the comment beside the
 * number. A rejection that felt noisy is not evidence. Where no such
 * measurement exists the floor sits at the pin, because a release Clio was
 * never run against is not something to discover through a failure that reads
 * as a bug in the feature.
 *
 * The cost of a floor lands on an operator whose own copy is a release or two
 * behind, so `describeResolution` in `resolve.ts` is required to name what it
 * found, the floor it missed, and the command that fixes it.
 */
export const PINNED_TOOLS: ReadonlyArray<PinnedTool> = [
	{
		id: "asciinema",
		notice: [
			"asciinema 3.2.1, https://github.com/asciinema/asciinema/tree/v3.2.1",
			"Copyright asciinema contributors. Licensed under GNU GPL version 3 or later; see LICENSE.",
			"Clio invokes asciinema as a separate program. It is downloaded from upstream only on explicit request, not bundled into Clio.",
			"The exact v3.2.1 release source accompanies this installation in asciinema-3.2.1-source.tar.gz; see README.md and the source for build instructions and dependency licenses.",
			"Preserve the license and corresponding source when redistributing this program under the GPL.",
		].join("\n"),
		version: "3.2.1",
		summary: "terminal recording and asciicast playback (separate GPL program)",
		homepage: "https://asciinema.org",
		license: "GPL-3.0-or-later",
		binaries: ["asciinema"],
		primaryBinary: "asciinema",
		// 3.2.1 --version and output-only v2 playback exercised; older releases unqualified.
		minimumVersion: "3.2.1",
		versionArgs: ["--version"],
		downloads: {
			"linux-x64": {
				url: "https://github.com/asciinema/asciinema/releases/download/v3.2.1/asciinema-x86_64-unknown-linux-musl",
				sha256: "bec9781bc8f297a9d3d74ff60205599507f2abba1183578b8b2f22be4c999214",
				archive: "raw",
				binaryMembers: { asciinema: "" },
				documentMembers: [],
			},
		},
		// User-level download only; retain upstream license, source and source/build information beside the program.
		documents: [
			{
				name: "LICENSE",
				url: "https://raw.githubusercontent.com/asciinema/asciinema/v3.2.1/LICENSE",
				sha256: "8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903",
			},
			{
				name: "README.md",
				url: "https://raw.githubusercontent.com/asciinema/asciinema/v3.2.1/README.md",
				sha256: "8aeeace7213099fd6ad80f717dbe5ff82f9c2a375b9de054f4808e11bfa949eb",
			},
			{
				name: "asciinema-3.2.1-source.tar.gz",
				url: "https://codeload.github.com/asciinema/asciinema/tar.gz/refs/tags/v3.2.1",
				sha256: "e7e49a09c664a76afc5bc25ca09871eb090bfbe68a2ddbc72750d3cb215d36f1",
			},
		],
	},
	{
		id: "herdr",
		version: "0.9.3",
		summary: "terminal multiplexer with an agent-aware socket API; powers Clio panes",
		homepage: "https://herdr.dev",
		license: "Apache-2.0",
		binaries: ["herdr"],
		primaryBinary: "herdr",
		// Lowered from the pin on evidence, which is the bar this file sets for
		// moving a floor. `herdr api schema --json` was read from 0.7.5
		// (protocol 17), 0.8.2 (protocol 20) and the pinned 0.9.3 (protocol 22):
		// every method the mux domain sends exists in all three, including the
		// workspace, read, send-keys and wait methods the workspace launcher and
		// the panes tool use. The two methods
		// that are not universal are already gated at runtime by protocol number
		// in `src/domains/mux/protocol.ts`, whose own floor is 17, so an operator's
		// 0.7.5 takes the documented fallback rather than failing. 0.7.5 is the
		// oldest release actually checked, not the oldest that might work.
		minimumVersion: "0.7.5",
		versionArgs: ["--version"],
		downloads: {
			"linux-x64": {
				url: "https://github.com/herdrdev/herdr/releases/download/v0.9.3/herdr-linux-x86_64",
				sha256: "18a8dc65f1c2fa485884344356dea1cfd911c6f06cf46fa78e193f4087f4dba7",
				archive: "raw",
				binaryMembers: { herdr: "" },
				documentMembers: [],
			},
			"linux-arm64": {
				url: "https://github.com/herdrdev/herdr/releases/download/v0.9.3/herdr-linux-aarch64",
				sha256: "4de7aa3e25678812e92960de64f7c2aaa1bca1f0f80a3c5e559837e231e1f5c0",
				archive: "raw",
				binaryMembers: { herdr: "" },
				documentMembers: [],
			},
			"darwin-x64": {
				url: "https://github.com/herdrdev/herdr/releases/download/v0.9.3/herdr-macos-x86_64",
				sha256: "db62d548ff3e832b087a96b1894a08d26be3905f1830309cd556783f215d4054",
				archive: "raw",
				binaryMembers: { herdr: "" },
				documentMembers: [],
			},
			"darwin-arm64": {
				url: "https://github.com/herdrdev/herdr/releases/download/v0.9.3/herdr-macos-aarch64",
				sha256: "5173a3e0ae42d5d1ab7ebfa5d5e6329f7c3d23f8e1a3677c7ce3231da2884157",
				archive: "raw",
				binaryMembers: { herdr: "" },
				documentMembers: [],
			},
			// The Windows asset is a zip: `herdr.exe` plus the ConPTY runtime it
			// loads from `conpty/` beside itself, so those members keep their
			// relative paths. The pin installs and resolves on Windows; the workspace
			// launcher and the pane client still speak Unix sockets only, so panes
			// stay off there until the named-pipe transport exists.
			"win32-x64": {
				url: "https://github.com/herdrdev/herdr/releases/download/v0.9.3/herdr-windows-x86_64.zip",
				sha256: "c75b1fa49f7a3ba4b8b11789912a6147e4214a3b6fd3556d0f80076c8887d795",
				archive: "zip",
				binaryMembers: { herdr: "herdr.exe" },
				documentMembers: [
					"THIRD-PARTY-NOTICES/Microsoft.Windows.Console.ConPTY-LICENSE.txt",
					"THIRD-PARTY-NOTICES/Microsoft.Windows.Console.ConPTY-NOTICE.md",
				],
				runtimeMembers: [
					"conpty/conpty.dll",
					"conpty/herdr-conpty.json",
					"conpty/x64/OpenConsole.exe",
					"conpty/arm64/OpenConsole.exe",
				],
			},
		},
		// The Unix assets are bare executables, so the Apache-2.0 text comes
		// from the repository at the pinned tag.
		documents: [
			{
				name: "LICENSE",
				url: "https://raw.githubusercontent.com/herdrdev/herdr/v0.9.3/LICENSE",
				sha256: "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
			},
		],
	},
	{
		id: "yazi",
		version: "26.8.15",
		summary: "terminal file manager; the file-picker pane preset",
		homepage: "https://yazi-rs.github.io",
		license: "MIT",
		binaries: ["yazi", "ya"],
		primaryBinary: "yazi",
		// Stays at the pin, now for a measured reason rather than caution. On
		// 26.1.22 the one command Clio sends, `ya emit-to <receiver> cd <path>`,
		// has the same signature it has at the pin. What was never exercised
		// there is the rest of the surface: the managed profile Clio generates
		// (`yazi.toml`, `keymap.toml`, `init.lua`) and the DDS payload shapes a
		// pick comes back in. A profile schema mismatch degrades quietly into a
		// file manager that opens and does the wrong thing, which is worse than
		// vendoring a second copy. Lower this once a pick round trip has been
		// driven end to end on the older release.
		minimumVersion: "26.8.15",
		versionArgs: ["--version"],
		downloads: {
			"linux-x64": {
				url: "https://github.com/sxyazi/yazi/releases/download/v26.8.15/yazi-x86_64-unknown-linux-gnu.zip",
				sha256: "cc67eb7991550c2f9407cda52d3f5af0937627aa6884e7de99a04fcf059807e0",
				archive: "zip",
				binaryMembers: {
					yazi: "yazi-x86_64-unknown-linux-gnu/yazi",
					ya: "yazi-x86_64-unknown-linux-gnu/ya",
				},
				documentMembers: ["yazi-x86_64-unknown-linux-gnu/LICENSE"],
			},
			"linux-arm64": {
				url: "https://github.com/sxyazi/yazi/releases/download/v26.8.15/yazi-aarch64-unknown-linux-gnu.zip",
				sha256: "f5a85771f06bb0e8c488136ae0aedaec8d341a7cee995549df391d7d852fe8d1",
				archive: "zip",
				binaryMembers: {
					yazi: "yazi-aarch64-unknown-linux-gnu/yazi",
					ya: "yazi-aarch64-unknown-linux-gnu/ya",
				},
				documentMembers: ["yazi-aarch64-unknown-linux-gnu/LICENSE"],
			},
			"darwin-x64": {
				url: "https://github.com/sxyazi/yazi/releases/download/v26.8.15/yazi-x86_64-apple-darwin.zip",
				sha256: "70bb2bcf57d8af862a54e2d12f2fddceefb9aa4ba3783e9a4dcbf2a8e64aacb3",
				archive: "zip",
				binaryMembers: {
					yazi: "yazi-x86_64-apple-darwin/yazi",
					ya: "yazi-x86_64-apple-darwin/ya",
				},
				documentMembers: ["yazi-x86_64-apple-darwin/LICENSE"],
			},
			"darwin-arm64": {
				url: "https://github.com/sxyazi/yazi/releases/download/v26.8.15/yazi-aarch64-apple-darwin.zip",
				sha256: "3f54907ea08abe96506f4b22239340ed8923a6aeaeae78f33d59bce57daca4cd",
				archive: "zip",
				binaryMembers: {
					yazi: "yazi-aarch64-apple-darwin/yazi",
					ya: "yazi-aarch64-apple-darwin/ya",
				},
				documentMembers: ["yazi-aarch64-apple-darwin/LICENSE"],
			},
			// Same shape as the other three: two executables and a LICENSE at
			// known member paths, so the installer needs nothing new to place it.
			"win32-x64": {
				url: "https://github.com/sxyazi/yazi/releases/download/v26.8.15/yazi-x86_64-pc-windows-msvc.zip",
				sha256: "451f6770999fa8f9b08e6c9f94a688c263b6d3007b0944c4407f1ae335eace30",
				archive: "zip",
				binaryMembers: {
					yazi: "yazi-x86_64-pc-windows-msvc/yazi.exe",
					ya: "yazi-x86_64-pc-windows-msvc/ya.exe",
				},
				documentMembers: ["yazi-x86_64-pc-windows-msvc/LICENSE"],
			},
		},
		documents: [],
	},
	{
		id: "croc",
		version: "11.3.6",
		summary: "relay file transfer between machines; the transfer primitive's first backend",
		homepage: "https://schollz.com/software/croc6",
		license: "MIT",
		binaries: ["croc"],
		primaryBinary: "croc",
		// Croc negotiates its relay protocol by major version, so any 11.x on
		// PATH speaks to a pinned 11.x relay.
		minimumVersion: "11.0.0",
		versionArgs: ["--version"],
		downloads: {
			"linux-x64": {
				url: "https://github.com/schollz/croc/releases/download/v11.3.6/croc_v11.3.6_Linux-64bit.tar.gz",
				sha256: "bd18e01024f5ccc8e101c08c8233d4cffbfda4ff59acad80eaa1fc2963efc0b2",
				archive: "tar.gz",
				binaryMembers: { croc: "croc" },
				documentMembers: ["LICENSE", "THIRD_PARTY_NOTICES.md"],
			},
			"linux-arm64": {
				url: "https://github.com/schollz/croc/releases/download/v11.3.6/croc_v11.3.6_Linux-ARM64.tar.gz",
				sha256: "c26ac67207301ed75ae0ece63796ec8a2a002b1cf64f4e3d3d8e7bcee508b5b3",
				archive: "tar.gz",
				binaryMembers: { croc: "croc" },
				documentMembers: ["LICENSE", "THIRD_PARTY_NOTICES.md"],
			},
			"darwin-x64": {
				url: "https://github.com/schollz/croc/releases/download/v11.3.6/croc_v11.3.6_macOS-64bit.tar.gz",
				sha256: "701817a20f4d2bb4312f3234e6d328e0bdd68d6d1311db3a4ab4daf10906c5b2",
				archive: "tar.gz",
				binaryMembers: { croc: "croc" },
				documentMembers: ["LICENSE", "THIRD_PARTY_NOTICES.md"],
			},
			"darwin-arm64": {
				url: "https://github.com/schollz/croc/releases/download/v11.3.6/croc_v11.3.6_macOS-ARM64.tar.gz",
				sha256: "96c4ef67751b4387e3d44a7a559aafe54094f0089f34a6c71dfb5361bd48d368",
				archive: "tar.gz",
				binaryMembers: { croc: "croc" },
				documentMembers: ["LICENSE", "THIRD_PARTY_NOTICES.md"],
			},
			// A zip rather than a tarball on Windows, and the only entry in the
			// table whose hash is confirmed by upstream's own checksums file
			// rather than only by the download this repository made.
			"win32-x64": {
				url: "https://github.com/schollz/croc/releases/download/v11.3.6/croc_v11.3.6_Windows-64bit.zip",
				sha256: "ed22552d371d55a9e3c3b612b982484fa00adaff8fb32c3f19f36dbf8e248bbf",
				archive: "zip",
				binaryMembers: { croc: "croc.exe" },
				documentMembers: ["LICENSE", "THIRD_PARTY_NOTICES.md"],
			},
		},
		documents: [],
	},
	{
		id: "cliamp",
		version: "1.63.2",
		summary: "terminal music player with outside control; the music pane",
		homepage: "https://cliamp.stream",
		license: "MIT",
		binaries: ["cliamp"],
		primaryBinary: "cliamp",
		// At the pin. The surfaces Clio drives (`CLIAMP_CONFIG_DIR`, `--playlist`,
		// and the `next`, `load`, `status --json` IPC commands) were exercised on
		// 1.63.2 in a herdr pane and on nothing older.
		minimumVersion: "1.63.2",
		versionArgs: ["--version"],
		// Every hash below matched upstream's own checksums.txt for this tag.
		// The Linux assets link the codecs statically; the macOS ones load
		// FLAC, Vorbis, Ogg and mpg123 from Homebrew, which `brew install
		// bjarneo/cliamp/cliamp` brings along and a vendored copy does not.
		downloads: {
			"linux-x64": {
				url: "https://github.com/bjarneo/cliamp/releases/download/v1.63.2/cliamp-linux-amd64",
				sha256: "b066832c84cb9dffcb126252dedb55a0ebcd13cbac95bbff103b111b88ce17c9",
				archive: "raw",
				binaryMembers: { cliamp: "" },
				documentMembers: [],
			},
			"linux-arm64": {
				url: "https://github.com/bjarneo/cliamp/releases/download/v1.63.2/cliamp-linux-arm64",
				sha256: "3be4ebe8806d2432b58afedd0fbdcb9522266b0204ab6cddb7f519f6ee33a8aa",
				archive: "raw",
				binaryMembers: { cliamp: "" },
				documentMembers: [],
			},
			"darwin-x64": {
				url: "https://github.com/bjarneo/cliamp/releases/download/v1.63.2/cliamp-darwin-amd64",
				sha256: "e8595ba960be284cf6ab21a3dd34537a8ddca4fca4fd253f057e02379f608276",
				archive: "raw",
				binaryMembers: { cliamp: "" },
				documentMembers: [],
			},
			"darwin-arm64": {
				url: "https://github.com/bjarneo/cliamp/releases/download/v1.63.2/cliamp-darwin-arm64",
				sha256: "e9786bcedb5c284a6c15b8d472b846e67e321ab9e95b688ef999de24baec6074",
				archive: "raw",
				binaryMembers: { cliamp: "" },
				documentMembers: [],
			},
			"win32-x64": {
				url: "https://github.com/bjarneo/cliamp/releases/download/v1.63.2/cliamp-windows-amd64.exe",
				sha256: "bc72bb495fcf21e2d61b434a5fcd7c6c2848f09fd4f78cb4b6952a6d970f43a2",
				archive: "raw",
				binaryMembers: { cliamp: "" },
				documentMembers: [],
			},
		},
		documents: [
			{
				name: "LICENSE",
				url: "https://raw.githubusercontent.com/bjarneo/cliamp/v1.63.2/LICENSE",
				sha256: "57764ebae827c1c96dc5c1b74e2579ff34d3abcaabb54f5e5498fb2f612330cc",
			},
		],
	},
];

/**
 * Package-manager alternatives to `clio-coder tools install <id>`, per
 * platform, for tools whose upstream publishes them. Clio prints these and
 * never runs them: an install is something the operator types.
 */
export function packageManagerInstallHints(id: string, platform: NodeJS.Platform = process.platform): string[] {
	if (id !== "cliamp") return [];
	const hints = platform === "darwin" ? ["brew install bjarneo/cliamp/cliamp"] : [];
	hints.push("go install github.com/bjarneo/cliamp@latest");
	return hints;
}

/** The registry's platform key for the running process, or null when unmapped. */
export function currentToolPlatform(): ToolPlatform | null {
	const platform = process.platform;
	const arch = process.arch;
	if (platform === "linux") {
		if (arch === "x64") return "linux-x64";
		if (arch === "arm64") return "linux-arm64";
		return null;
	}
	if (platform === "darwin") {
		if (arch === "x64") return "darwin-x64";
		if (arch === "arm64") return "darwin-arm64";
		return null;
	}
	if (platform === "win32" && arch === "x64") return "win32-x64";
	return null;
}

/** The row with this id. */
export function findPinnedTool(id: string): PinnedTool | null {
	return PINNED_TOOLS.find((entry) => entry.id === id) ?? null;
}

/**
 * The row that owns this executable name.
 *
 * Resolution is asked for by binary name (`ya` belongs to yazi), so the lookup
 * has to cover every name an entry installs, not just the tool id.
 */
export function findPinnedToolByBinary(name: string): PinnedTool | null {
	const bare = name.endsWith(".exe") ? name.slice(0, -4) : name;
	return PINNED_TOOLS.find((entry) => entry.binaries.includes(bare)) ?? null;
}
