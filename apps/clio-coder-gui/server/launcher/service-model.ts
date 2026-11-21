import { createHash } from "node:crypto";
import { join } from "node:path";

/**
 * Which user service manager keeps the background app running from login on a host, and how each one is
 * driven. Everything here is pure: the identity and file text of the service, the commands an action runs and
 * the reading of a manager's status into the systemd property vocabulary `background.ts` checks
 * (FragmentPath, ActiveState, UnitFileState, MainPID). process-policy.ts runs the commands.
 */
export type ServiceHost = "systemd" | "launchd" | "task-scheduler";
export type ServiceAction = "show" | "enable" | "start" | "restart" | "stop" | "disable" | "reload";

export function serviceHost(platform: string): ServiceHost | null {
	const os = platform.split("-")[0] ?? platform;
	return os === "linux" ? "systemd" : os === "darwin" ? "launchd" : os === "win32" ? "task-scheduler" : null;
}

const UNIT = /^clio-coder-gui-[a-f0-9]{12}\.service$/;
const LABEL = /^ai\.iowarp\.clio-coder-gui\.[a-f0-9]{12}$/;
const TASK = /^clio-coder-gui-[a-f0-9]{12}$/;

/** The service name and the owned file that defines it, beside the background configuration. */
export function serviceIdentity(directory: string, platform: string) {
	const id = createHash("sha256").update(directory).digest("hex").slice(0, 12);
	const host = serviceHost(platform);
	if (host === "launchd") {
		const unit = `ai.iowarp.clio-coder-gui.${id}`;
		return { unit, unitFile: join(directory, `${unit}.plist`) };
	}
	if (host === "task-scheduler") {
		const unit = `clio-coder-gui-${id}`;
		return { unit, unitFile: join(directory, `${unit}.task.json`) };
	}
	const unit = `clio-coder-gui-${id}.service`;
	return { unit, unitFile: join(directory, unit) };
}

/** A service name this app made for `host`, and nothing a caller could point at another service. */
export function isServiceName(host: ServiceHost, unit: string) {
	return (host === "systemd" ? UNIT : host === "launchd" ? LABEL : TASK).test(unit);
}

const noControl = (value: string) => {
	if ([...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
		throw new Error("Service paths cannot contain control characters.");
	return value;
};
const xml = (value: string) =>
	noControl(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * A per-user LaunchAgent: launchd starts it at login (RunAtLoad), restarts it when it fails but not after a clean
 * exit (KeepAlive SuccessfulExit false), and creates its files private (Umask 0077).
 */
export function launchdPlist(label: string, argv: readonly string[]) {
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		'<plist version="1.0">',
		"<dict>",
		"\t<key>Label</key>",
		`\t<string>${xml(label)}</string>`,
		"\t<key>ProgramArguments</key>",
		"\t<array>",
		...argv.map((value) => `\t\t<string>${xml(value)}</string>`),
		"\t</array>",
		"\t<key>RunAtLoad</key>",
		"\t<true/>",
		"\t<key>KeepAlive</key>",
		"\t<dict>",
		"\t\t<key>SuccessfulExit</key>",
		"\t\t<false/>",
		"\t</dict>",
		"\t<key>ThrottleInterval</key>",
		"\t<integer>5</integer>",
		"\t<key>ExitTimeOut</key>",
		"\t<integer>15</integer>",
		"\t<key>Umask</key>",
		"\t<integer>63</integer>",
		"\t<key>ProcessType</key>",
		"\t<string>Interactive</string>",
		"</dict>",
		"</plist>",
		"",
	].join("\n");
}

/** One argument quoted for CommandLineToArgvW, which Node and most Windows programs parse their command line with. */
export function windowsArgument(value: string) {
	noControl(value);
	if (value !== "" && !/[\s"]/.test(value)) return value;
	let quoted = '"',
		slashes = 0;
	for (const char of value) {
		if (char === "\\") {
			slashes += 1;
			continue;
		}
		quoted += char === '"' ? `${"\\".repeat(slashes * 2 + 1)}"` : `${"\\".repeat(slashes)}${char}`;
		slashes = 0;
	}
	return `${quoted}${"\\".repeat(slashes * 2)}"`;
}

/**
 * A per-user logon task. Task Scheduler starts the app when this user signs in; `conhost --headless` keeps the
 * console app from opening a window. The file is the task's whole definition, registered from these fields.
 */
export function taskSpec(name: string, argv: readonly string[]) {
	const command = {
		v: 1,
		name,
		execute: "conhost.exe",
		arguments: ["--headless", ...argv].map(windowsArgument).join(" "),
	};
	return `${JSON.stringify(command, null, 2)}\n`;
}
export type TaskSpec = { v: 1; name: string; execute: string; arguments: string };
export function parseTaskSpec(text: string): TaskSpec {
	const value = JSON.parse(text) as Partial<TaskSpec>;
	if (
		value?.v !== 1 ||
		typeof value.name !== "string" ||
		!TASK.test(value.name) ||
		value.execute !== "conhost.exe" ||
		typeof value.arguments !== "string"
	)
		throw new Error("The background task definition is invalid.");
	return value as TaskSpec;
}

/** The launchd domain target of this user's login session and its one job. */
export const launchdDomain = (uid: number) => `gui/${uid}`;
export const launchdJob = (uid: number, label: string) => `${launchdDomain(uid)}/${label}`;

/**
 * The launchctl calls an action makes once the agent file in ~/Library/LaunchAgents is in place (enable and
 * reload copy it there first; disable removes it after). `tolerate` marks a call whose failure means only that
 * the job was already in the wanted state. Stop unloads the job, so nothing restarts it until the next login or
 * start; launchd reads a changed definition only when the job loads again, so restart reloads it.
 */
export function launchdCalls(action: Exclude<ServiceAction, "show">, label: string, agentFile: string, uid: number) {
	const job = launchdJob(uid, label),
		domain = launchdDomain(uid);
	const bootout = { argv: ["bootout", job], tolerate: true };
	const bootstrap = { argv: ["bootstrap", domain, agentFile], tolerate: false };
	switch (action) {
		case "enable":
			return [bootout, bootstrap];
		case "start":
			return [
				{ ...bootstrap, tolerate: true },
				{ argv: ["kickstart", job], tolerate: false },
			];
		case "restart":
			return [bootout, bootstrap];
		case "stop":
		case "disable":
			return [bootout];
		case "reload":
			return [];
	}
}

/**
 * How the agent file in ~/Library/LaunchAgents compares with the owned definition beside the configuration.
 * `stale` is this job's own earlier definition (its label carries the hash of this directory), left there
 * until the next enable or reload copies the current one; `different` is anything else under that name.
 */
export type AgentCopy = "absent" | "same" | "stale" | "different";
export function agentCopy(agent: string | null, owned: string | null, label: string): AgentCopy {
	if (agent === null) return "absent";
	if (owned !== null && agent === owned) return "same";
	return agent.includes(`<key>Label</key>\n\t<string>${xml(label)}</string>`) ? "stale" : "different";
}

/** `launchctl print` output (null when the job is not loaded) read as the systemd properties background.ts checks. */
export function launchdStatus(print: string | null, agent: AgentCopy, unitFile: string, agentFile: string) {
	const field = (name: string) => print?.match(new RegExp(`^\\s*${name} = (.*)$`, "m"))?.[1]?.trim();
	const loadedFrom = field("path");
	const fragment =
		print === null
			? agent === "different"
				? agentFile
				: agent === "absent"
					? ""
					: unitFile
			: loadedFrom === agentFile && (agent === "same" || agent === "stale")
				? unitFile
				: (loadedFrom ?? agentFile);
	const pid = Number(field("pid"));
	return [
		`FragmentPath=${fragment}`,
		`ActiveState=${field("state") === "running" ? "active" : "inactive"}`,
		`UnitFileState=${agent === "same" || agent === "stale" ? "enabled" : "disabled"}`,
		`MainPID=${Number.isInteger(pid) && pid > 0 ? pid : 0}`,
		"",
	].join("\n");
}

/**
 * The fixed PowerShell scripts that drive Task Scheduler. Values arrive only as environment variables
 * (CLIO_TASK_NAME, CLIO_TASK_EXECUTE, CLIO_TASK_ARGUMENTS), so no path is ever parsed as PowerShell.
 */
const TASK_PATH = "\\CLIO Coder\\";
const taskLookup = `$t = Get-ScheduledTask -TaskPath '${TASK_PATH}' -TaskName $env:CLIO_TASK_NAME -ErrorAction SilentlyContinue`;
export function taskScript(action: ServiceAction) {
	const strict = "$ErrorActionPreference = 'Stop'";
	switch (action) {
		case "show":
			return [
				strict,
				taskLookup,
				"if ($null -eq $t) { '{}' } else { $a = @($t.Actions)[0]; $i = Get-ScheduledTaskInfo -InputObject $t; @{ state = [int]$t.State; enabled = [bool]$t.Settings.Enabled; execute = [string]$a.Execute; arguments = [string]$a.Arguments; pid = 0; lastResult = [int]$i.LastTaskResult } | ConvertTo-Json -Compress }",
			].join("; ");
		case "enable":
			return [
				strict,
				"$action = New-ScheduledTaskAction -Execute $env:CLIO_TASK_EXECUTE -Argument $env:CLIO_TASK_ARGUMENTS",
				"$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)",
				"$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)",
				`Register-ScheduledTask -TaskPath '${TASK_PATH}' -TaskName $env:CLIO_TASK_NAME -Action $action -Trigger $trigger -Settings $settings -Description 'Keeps the CLIO Coder graphical application running while you are signed in' -Force | Out-Null`,
				`Start-ScheduledTask -TaskPath '${TASK_PATH}' -TaskName $env:CLIO_TASK_NAME`,
			].join("; ");
		case "start":
			return [strict, `Start-ScheduledTask -TaskPath '${TASK_PATH}' -TaskName $env:CLIO_TASK_NAME`].join("; ");
		case "restart":
			return [
				strict,
				`Stop-ScheduledTask -TaskPath '${TASK_PATH}' -TaskName $env:CLIO_TASK_NAME`,
				`Start-ScheduledTask -TaskPath '${TASK_PATH}' -TaskName $env:CLIO_TASK_NAME`,
			].join("; ");
		case "stop":
			return [strict, `Stop-ScheduledTask -TaskPath '${TASK_PATH}' -TaskName $env:CLIO_TASK_NAME`].join("; ");
		case "disable":
			return [
				strict,
				taskLookup,
				"if ($null -ne $t) { Stop-ScheduledTask -InputObject $t; Unregister-ScheduledTask -InputObject $t -Confirm:$false }",
			].join("; ");
		case "reload":
			// A registered task keeps its own copy of the definition: re-register it in place, leaving a running app alone.
			return [
				strict,
				taskLookup,
				"if ($null -ne $t) { $action = New-ScheduledTaskAction -Execute $env:CLIO_TASK_EXECUTE -Argument $env:CLIO_TASK_ARGUMENTS; Set-ScheduledTask -InputObject $t -Action $action | Out-Null }",
			].join("; ");
	}
}

/** The task's state (from the show script's JSON) read as the systemd properties background.ts checks. */
export function taskStatus(json: string, spec: TaskSpec, unitFile: string) {
	const value = JSON.parse(json || "{}") as {
		state?: number;
		enabled?: boolean;
		execute?: string;
		arguments?: string;
	};
	const registered = typeof value.state === "number";
	const ours = value.execute === spec.execute && value.arguments === spec.arguments;
	return [
		// A task with this name whose action is not ours reads as another service; realpath of it never matches.
		`FragmentPath=${registered ? (ours ? unitFile : `task:${TASK_PATH}${spec.name}`) : ""}`,
		`ActiveState=${value.state === 4 ? "active" : "inactive"}`,
		`UnitFileState=${registered && value.enabled !== false ? "enabled" : "disabled"}`,
		"MainPID=0",
		"",
	].join("\n");
}
