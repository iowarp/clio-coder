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
 * platform without a checksum.
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
		// The socket surface Clio's mux domain drives is only verified against
		// the pin, so the pin is also the floor. Lower it deliberately, with a
		// version whose `herdr api schema --json` was actually checked.
		minimumVersion: "0.8.2",
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
		// Yazi versions by date and moves its plugin and DDS surfaces between
		// releases, so the floor stays at the pin until a round trip pins the
		// oldest release it actually works against.
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
