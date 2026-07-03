const fleetWorkerTarget = { kind: "fleet", role: "workers", field: "target" };
const fleetWorkerModel = { kind: "fleet", role: "workers", field: "model" };
const fleetWorkerThinking = { kind: "fleet", role: "workers", field: "thinking" };
const scratchWorkspace = { kind: "scratch", name: "workspace" };

const defaultWorkerInvocation = {
	kind: "clio-run-agent",
	agent: "coder",
	target: fleetWorkerTarget,
	model: fleetWorkerModel,
	thinking_level: fleetWorkerThinking,
	cwd: scratchWorkspace,
	json: true,
};

const escalationBaseOverlay = {
	autonomy: "suggest",
	workers: {
		onPermission: "escalate",
		escalation: { timeoutMs: 120_000, fallback: "deny" },
	},
};

const noEscalationDecisionKeys = [
	"escalationRequested",
	"escalationApproved",
	"escalationDenied",
	"escalationTimedOut",
];

function writeTask(fileName) {
	return `Create a file named ${fileName} containing the text hello-world. Use the write tool.`;
}

export const ESCALATION_SCENARIOS = [
	{
		id: "e1-timeout-fallback",
		reportScenario: "worker permission escalation scenario 1",
		tier: "live",
		title: "Headless escalate posture resolves by timeout fallback",
		retryClass: "model-behavior",
		settingsOverlay: {
			autonomy: "suggest",
			workers: {
				onPermission: "escalate",
				escalation: { timeoutMs: 8_000, fallback: "deny" },
			},
		},
		invocation: {
			...defaultWorkerInvocation,
			task: writeTask("escalate-timeout.txt"),
		},
		expectations: [
			{ kind: "event-seen", type: "clio_permission_escalated" },
			{ kind: "event-field", type: "clio_permission_resolved", path: ["payload", "source"], equals: "timeout" },
			{ kind: "event-field", type: "clio_permission_resolved", path: ["payload", "mode"], equals: "deny" },
			{ kind: "receipt-field", path: ["exitCode"], equals: 0 },
			{ kind: "receipt-field", path: ["outcome"], equals: "succeeded" },
			{ kind: "receipt-field", path: ["integrity", "digest"], present: true },
			{ kind: "receipt-field", path: ["safety", "decisions", "permissionRequested"], equals: 1 },
			{ kind: "receipt-field", path: ["safety", "decisions", "escalationRequested"], equals: 1 },
			{ kind: "receipt-field", path: ["safety", "decisions", "escalationTimedOut"], equals: 1 },
			{ kind: "workspace-file-absent", path: "escalate-timeout.txt" },
		],
	},
	{
		id: "e2-deny-fail-unchanged",
		reportScenario: "worker permission escalation scenario 2",
		tier: "live",
		title: "Deny and fail postures keep pre-escalation event and receipt shapes",
		retryClass: "model-behavior",
		cases: [
			{
				id: "deny",
				settingsOverlay: {
					autonomy: "suggest",
					workers: { onPermission: "deny" },
				},
				invocation: {
					...defaultWorkerInvocation,
					task: writeTask("deny-posture.txt"),
				},
				expectations: [
					{ kind: "event-field", type: "clio_permission_resolved", path: ["payload", "mode"], equals: "deny" },
					{ kind: "event-field", type: "clio_permission_resolved", path: ["payload", "source"], absent: true },
					{ kind: "receipt-field", path: ["exitCode"], equals: 0 },
					{ kind: "receipt-field", path: ["outcome"], equals: "succeeded" },
					{ kind: "receipt-field", path: ["safety", "decisions", "permissionRequested"], equals: 1 },
					{ kind: "receipt-forbidden-keys", path: ["safety", "decisions"], keys: noEscalationDecisionKeys },
					{ kind: "workspace-file-absent", path: "deny-posture.txt" },
				],
			},
			{
				id: "fail",
				settingsOverlay: {
					autonomy: "suggest",
					workers: { onPermission: "fail" },
				},
				invocation: {
					...defaultWorkerInvocation,
					task: writeTask("fail-posture.txt"),
				},
				expectations: [
					{ kind: "event-field", type: "clio_permission_resolved", path: ["payload", "mode"], equals: "fail" },
					{ kind: "event-field", type: "clio_permission_resolved", path: ["payload", "source"], absent: true },
					{ kind: "receipt-field", path: ["exitCode"], equals: 3 },
					{ kind: "receipt-field", path: ["outcome"], equals: "failed" },
					{ kind: "receipt-field", path: ["outcomeDetail"], equals: "permission_required" },
					{ kind: "receipt-field", path: ["safety", "decisions", "permissionRequested"], equals: 1 },
					{ kind: "receipt-forbidden-keys", path: ["safety", "decisions"], keys: noEscalationDecisionKeys },
					{ kind: "workspace-file-absent", path: "fail-posture.txt" },
				],
			},
		],
	},
	{
		id: "e3-abort-parked",
		reportScenario: "worker permission escalation scenario 3",
		tier: "live",
		title: "Abort while escalation is parked seals a canceled receipt",
		retryClass: "model-behavior",
		settingsOverlay: escalationBaseOverlay,
		invocation: {
			...defaultWorkerInvocation,
			task: writeTask("abort-parked.txt"),
			abortAfterEvent: "clio_permission_escalated",
		},
		expectations: [
			{ kind: "event-seen", type: "clio_permission_escalated" },
			{ kind: "event-not-seen", type: "clio_permission_resolved" },
			{ kind: "receipt-field", path: ["exitCode"], equals: 1 },
			{ kind: "receipt-field", path: ["outcome"], equals: "canceled" },
			{ kind: "receipt-field", path: ["outcomeDetail"], equals: "operator abort" },
			{ kind: "receipt-field", path: ["integrity", "digest"], present: true },
			{ kind: "receipt-field", path: ["safety", "decisions", "escalationRequested"], equals: 1 },
			{ kind: "receipt-field", path: ["safety", "decisions", "escalationTimedOut"], equals: 0 },
			{ kind: "workspace-file-absent", path: "abort-parked.txt" },
		],
	},
	{
		id: "e4-heartbeat-continuity",
		reportScenario: "worker permission escalation scenario 4",
		tier: "live",
		title: "Heartbeats continue while permission is parked",
		retryClass: "model-behavior",
		settingsOverlay: {
			autonomy: "suggest",
			workers: {
				onPermission: "escalate",
				escalation: { timeoutMs: 30_000, fallback: "deny" },
			},
		},
		invocation: {
			...defaultWorkerInvocation,
			task: writeTask("heartbeat-parked.txt"),
			checkFleetStatusWhileParked: true,
		},
		expectations: [
			{ kind: "event-seen", type: "clio_permission_escalated" },
			{ kind: "event-field", type: "clio_permission_resolved", path: ["payload", "source"], equals: "timeout" },
			{
				kind: "heartbeat-count-between-events",
				from: "clio_permission_escalated",
				to: "clio_permission_resolved",
				min: 2,
			},
			{ kind: "fleet-status-while-parked", expected: "alive" },
			{ kind: "receipt-field", path: ["outcome"], equals: "succeeded" },
			{ kind: "receipt-field", path: ["safety", "decisions", "escalationTimedOut"], equals: 1 },
			{ kind: "receipt-field-not-equals", path: ["outcome"], value: "stalled" },
			{ kind: "receipt-field-not-equals", path: ["outcome"], value: "dead" },
			{ kind: "workspace-file-absent", path: "heartbeat-parked.txt" },
		],
	},
	{
		id: "e5-interactive-approve",
		reportScenario: "worker permission escalation scenario 5",
		tier: "interactive",
		title: "Interactive operator approval resumes the parked worker call",
		retryClass: "operator",
		optInEnv: "CLIO_BATTLETEST_INTERACTIVE",
		settingsOverlay: escalationBaseOverlay,
		invocation: {
			...defaultWorkerInvocation,
			kind: "tmux-clio-run-agent",
			task: writeTask("approved.txt"),
			approveOnOverlay: true,
		},
		expectations: [
			{ kind: "overlay-text-includes", text: "asks to run write" },
			{ kind: "overlay-text-includes", text: "Allow this action once?" },
			{ kind: "workspace-file-contains", path: "approved.txt", text: "hello-world" },
			{ kind: "receipt-field", path: ["exitCode"], equals: 0 },
			{ kind: "receipt-field", path: ["outcome"], equals: "succeeded" },
			{ kind: "receipt-field", path: ["safety", "decisions", "escalationRequested"], equals: 1 },
			{ kind: "receipt-field", path: ["safety", "decisions", "escalationApproved"], equals: 1 },
			{ kind: "receipt-field", path: ["safety", "decisions", "escalationTimedOut"], equals: 0 },
		],
	},
];

export const ESCALATION_SCENARIO_IDS = ESCALATION_SCENARIOS.map((scenario) => scenario.id);

export function findEscalationScenario(id) {
	return ESCALATION_SCENARIOS.find((scenario) => scenario.id === id) ?? null;
}
