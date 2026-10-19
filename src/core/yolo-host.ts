import { existsSync, readFileSync } from "node:fs";

/**
 * Root refusal for yolo (#407). Yolo runs every command without asking and
 * without a sandbox by default, so as root on a real host one bad step can
 * take the machine with it. Inside a container the blast radius is the
 * container, which is where operators run long unattended jobs, so yolo is
 * refused only for an effective uid 0 outside a detected container. Windows
 * has no effective uid and is never refused.
 */

/** What the refusal reads about the host; injectable so a test decides it. */
export interface YoloHostFacts {
	platform: NodeJS.Platform;
	/** Effective uid, or null where the platform has none. */
	euid: number | null;
	/** `CLIO_CODER_SANDBOXED=1`: the operator attests the process already runs in a sandbox. */
	operatorAttestsSandbox: boolean;
	/** The `container` environment variable systemd-nspawn, podman and others set. */
	containerEnv: string | undefined;
	/** `KUBERNETES_SERVICE_HOST` is set. */
	kubernetes: boolean;
	/** `/.dockerenv` exists. */
	dockerenv: boolean;
	/** `/run/.containerenv` exists (podman). */
	containerenv: boolean;
	/** `/proc/1/cgroup`, or null when unreadable. */
	initCgroup: string | null;
}

function readOptional(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		// Absent or unreadable outside Linux; no cgroup evidence either way.
		return null;
	}
}

/** The facts of this process and host. */
function readYoloHostFacts(): YoloHostFacts {
	return {
		platform: process.platform,
		euid: typeof process.geteuid === "function" ? process.geteuid() : null,
		operatorAttestsSandbox: process.env.CLIO_CODER_SANDBOXED === "1",
		containerEnv: process.env.container,
		kubernetes: (process.env.KUBERNETES_SERVICE_HOST ?? "").length > 0,
		dockerenv: existsSync("/.dockerenv"),
		containerenv: existsSync("/run/.containerenv"),
		initCgroup: process.platform === "linux" ? readOptional("/proc/1/cgroup") : null,
	};
}

/** True when any container signal is present, or the operator attests a sandbox. */
function runsInContainer(facts: YoloHostFacts): boolean {
	return (
		facts.operatorAttestsSandbox ||
		(facts.containerEnv ?? "").length > 0 ||
		facts.kubernetes ||
		facts.dockerenv ||
		facts.containerenv ||
		(facts.initCgroup !== null && /docker|kubepods|containerd|lxc|podman/u.test(facts.initCgroup))
	);
}

/** What the operator reads when yolo is refused. */
export const YOLO_ROOT_REFUSAL =
	"yolo is refused: Clio runs as root outside a container, where an unattended command can damage the whole host. Run as a regular user, run inside a container, or set CLIO_CODER_SANDBOXED=1 to attest that this process is already sandboxed.";

/** The refusal, or null when yolo may run here. */
export function yoloRootRefusal(facts: YoloHostFacts = readYoloHostFacts()): string | null {
	if (facts.platform === "win32" || facts.euid !== 0) return null;
	return runsInContainer(facts) ? null : YOLO_ROOT_REFUSAL;
}
