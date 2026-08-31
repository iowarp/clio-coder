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
		id: "herdr",
		version: "0.8.2",
		summary: "terminal multiplexer with an agent-aware socket API; powers Clio panes",
		homepage: "https://herdr.dev",
		license: "Apache-2.0",
		binaries: ["herdr"],
		primaryBinary: "herdr",
		// Lowered from the pin on evidence, which is the bar this file sets for
		// moving a floor. `herdr api schema --json` was read from 0.7.5
		// (protocol 17) and 0.8.2 (protocol 20): every method the mux domain
		// sends exists in both, and the only two 0.8.2 adds, `workspace.move_block`
		// and `workspace.reordered`, are ones Clio never sends. The two methods
		// that are not universal are already gated at runtime by protocol number
		// in `src/domains/mux/protocol.ts`, whose own floor is 17, so an operator's
		// 0.7.5 takes the documented fallback rather than failing. 0.7.5 is the
		// oldest release actually checked, not the oldest that might work.
		minimumVersion: "0.7.5",
		versionArgs: ["--version"],
		downloads: {
			"linux-x64": {
				url: "https://github.com/herdrdev/herdr/releases/download/v0.8.2/herdr-linux-x86_64",
				sha256: "976150a14d490c94b243ea2e1a7eb2dfb67f12e36b182db90936f6728e6aecf4",
				archive: "raw",
				binaryMembers: { herdr: "" },
				documentMembers: [],
			},
			"linux-arm64": {
				url: "https://github.com/herdrdev/herdr/releases/download/v0.8.2/herdr-linux-aarch64",
				sha256: "f55610658e1c2e0d2aaef730b4b2ab885f7f8ba00285ab372bfb14f2e3d5b40d",
				archive: "raw",
				binaryMembers: { herdr: "" },
				documentMembers: [],
			},
			"darwin-x64": {
				url: "https://github.com/herdrdev/herdr/releases/download/v0.8.2/herdr-macos-x86_64",
				sha256: "ab50262c8190cd7aa9056d249d255c08c328c3e8716de9cfa29db4f131b8e2c1",
				archive: "raw",
				binaryMembers: { herdr: "" },
				documentMembers: [],
			},
			"darwin-arm64": {
				url: "https://github.com/herdrdev/herdr/releases/download/v0.8.2/herdr-macos-aarch64",
				sha256: "a5d4f4d504d8b309c91f811050559300faba31258425f53c50852fc96f6ae574",
				archive: "raw",
				binaryMembers: { herdr: "" },
				documentMembers: [],
			},
		},
		// No `win32-x64` entry, and not for want of an asset. herdr publishes
		// `herdr-windows-x86_64.zip` for this tag and it was downloaded and read:
		// alongside `herdr.exe` it carries a ConPTY runtime, `conpty/conpty.dll`
		// and `conpty/x64/OpenConsole.exe`, that has to sit in a subdirectory
		// beside the executable. The installer places every declared member flat
		// under its basename, so declaring this asset would install a `herdr.exe`
		// with its runtime scattered next to it, which is a broken install that
		// checksums and unpacks cleanly. Windows herdr waits on the installer
		// learning to preserve a member's relative path.
		//
		// The release asset is a bare executable, so the Apache-2.0 text comes
		// from the repository at the pinned tag.
		documents: [
			{
				name: "LICENSE",
				url: "https://raw.githubusercontent.com/herdrdev/herdr/v0.8.2/LICENSE",
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
];

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
