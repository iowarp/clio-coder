import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { resolveClioDirs, resolvePackageRoot } from "../clio/http-shims.js";

const path = Type.String({ minLength: 1, maxLength: 4096 });
const BackgroundConfig = Type.Object(
	{
		v: Type.Literal(1),
		port: Type.Integer({ minimum: 1, maximum: 65535 }),
		token: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }),
		roots: Type.Object({ config: path, data: path, state: path, cache: path }, { additionalProperties: false }),
		packageRoot: path,
		path: Type.String({ maxLength: 8192 }),
		launch: Type.Object(
			{ node: path, loader: Type.Optional(path), entry: path, icon: Type.Optional(path) },
			{ additionalProperties: false },
		),
		desktopPrefix: path,
	},
	{ additionalProperties: false },
);
export type BackgroundConfig = Static<typeof BackgroundConfig>;

export function backgroundPaths(directory: string) {
	if (!isAbsolute(directory)) throw new Error("The background directory must be absolute.");
	const id = createHash("sha256").update(directory).digest("hex").slice(0, 12);
	const unit = `clio-coder-web-${id}.service`;
	return {
		directory,
		config: join(directory, "server.json"),
		unit,
		unitFile: join(directory, unit),
		manifest: join(directory, "owner.json"),
	};
}
export async function readBackgroundConfig(file: string): Promise<BackgroundConfig> {
	const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		if (
			!stat.isFile() ||
			stat.nlink !== 1 ||
			stat.size > 16_384 ||
			(stat.mode & 0o077) !== 0 ||
			(process.getuid && stat.uid !== process.getuid())
		)
			throw new Error("Background credentials must be a private regular file owned by this user.");
		const value: unknown = JSON.parse(await handle.readFile("utf8"));
		if (
			!Value.Check(BackgroundConfig, value) ||
			![...Object.values(value.roots), value.packageRoot, value.desktopPrefix, ...Object.values(value.launch)].every(
				isAbsolute,
			)
		)
			throw new Error("Background configuration is invalid. No settings were applied.");
		return value;
	} finally {
		await handle.close();
	}
}
export async function newBackgroundConfig(
	port: number,
	launch: BackgroundConfig["launch"],
	desktopPrefix: string,
	env = process.env,
): Promise<BackgroundConfig> {
	const config = {
		v: 1 as const,
		port,
		token: randomBytes(32).toString("base64url"),
		roots: resolveClioDirs(),
		packageRoot: resolvePackageRoot(),
		path: env.PATH ?? "",
		launch: {
			node: await realpath(launch.node),
			...(launch.loader ? { loader: await realpath(launch.loader) } : {}),
			...(launch.icon ? { icon: await realpath(launch.icon) } : {}),
			entry: await realpath(launch.entry),
		},
		desktopPrefix,
	};
	if (!Value.Check(BackgroundConfig, config) || !isAbsolute(desktopPrefix))
		throw new Error("Invalid background setup options.");
	return config;
}
export function backgroundEnvironment(config: BackgroundConfig): NodeJS.ProcessEnv {
	return {
		PATH: config.path,
		CLIO_CODER_PACKAGE_ROOT: config.packageRoot,
		CLIO_CODER_CONFIG_DIR: config.roots.config,
		CLIO_CODER_DATA_DIR: config.roots.data,
		CLIO_CODER_STATE_DIR: config.roots.state,
		CLIO_CODER_CACHE_DIR: config.roots.cache,
	};
}

/** systemd syntax has its own escaping; neither a shell nor desktop Exec parsing applies. */
export function systemdArgument(value: string) {
	if ([...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
		throw new Error("Service paths cannot contain control characters.");
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}
export function backgroundUnit(config: BackgroundConfig, directory: string) {
	const argv = [
		config.launch.node,
		...(config.launch.loader ? ["--import", config.launch.loader] : []),
		config.launch.entry,
		"--persistent",
		backgroundPaths(directory).config,
	];
	return [
		"[Unit]",
		"Description=Clio Coder web application",
		"StartLimitIntervalSec=30",
		"StartLimitBurst=5",
		"",
		"[Service]",
		"Type=simple",
		`ExecStart=${argv.map(systemdArgument).join(" ")}`,
		"Restart=on-failure",
		"RestartSec=1",
		"KillMode=control-group",
		"TimeoutStopSec=15",
		"UMask=0077",
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	].join("\n");
}
