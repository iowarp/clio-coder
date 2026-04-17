import { BusChannels } from "../../core/bus-events.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { classify as classifyCall } from "./action-classifier.js";
import { type AuditRecord, type AuditWriter, buildAuditRecord, openAuditWriter } from "./audit.js";
import type { SafetyContract, SafetyDecision } from "./contract.js";
import { type DamageControlRuleset, loadDefaultRuleset, match as matchRule } from "./damage-control.js";
import { type LoopDetectorState, createLoopState, observe as observeLoop } from "./loop-detector.js";
import { formatRejection } from "./rejection-feedback.js";
import { DEFAULT_SCOPE, READONLY_SCOPE, SUPER_SCOPE, isSubset } from "./scope.js";

export function createSafetyBundle(context: DomainContext): DomainBundle<SafetyContract> {
	let writer: AuditWriter | null = null;
	let ruleset: DamageControlRuleset | null = null;
	let loopState: LoopDetectorState = createLoopState();
	let recordCount = 0;

	function writeAudit(rec: AuditRecord): void {
		if (writer === null) return;
		writer.write(rec);
		recordCount += 1;
	}

	const extension: DomainExtension = {
		async start() {
			ruleset = loadDefaultRuleset();
			writer = openAuditWriter();
		},
		async stop() {
			await writer?.close();
			writer = null;
		},
	};

	const contract: SafetyContract = {
		classify(call) {
			return classifyCall(call);
		},
		evaluate(call, mode) {
			const classification = classifyCall(call);

			// damage-control override: matched rule flips decision to block regardless of class
			const scan = serializeArgs(call.args);
			const hit = ruleset && scan ? matchRule(scan, ruleset) : null;

			const isHardBlock = classification.actionClass === "git_destructive" || hit?.block === true;

			context.bus.emit(BusChannels.SafetyClassified, {
				tool: call.tool,
				actionClass: classification.actionClass,
				reasons: classification.reasons,
				ruleId: hit?.ruleId,
				mode,
			});

			if (isHardBlock) {
				const rejectionCtx: Parameters<typeof formatRejection>[0] = {
					tool: call.tool,
					actionClass: classification.actionClass,
					reasons: [...classification.reasons, ...(hit ? [`damage-control:${hit.ruleId}`] : [])],
				};
				if (mode !== undefined) rejectionCtx.mode = mode;
				if (hit?.ruleId !== undefined) rejectionCtx.ruleId = hit.ruleId;
				const rejection = formatRejection(rejectionCtx);
				const auditInput: Parameters<typeof buildAuditRecord>[0] = {
					tool: call.tool,
					classification,
					decision: "blocked",
					args: call.args,
				};
				if (mode !== undefined) auditInput.mode = mode;
				const record = buildAuditRecord(auditInput);
				writeAudit(record);
				context.bus.emit(BusChannels.SafetyBlocked, {
					tool: call.tool,
					actionClass: classification.actionClass,
					ruleId: hit?.ruleId,
					mode,
					rejection,
				});
				const decision: SafetyDecision = { kind: "block", classification, rejection };
				if (hit) (decision as { match?: typeof hit }).match = hit;
				return decision;
			}

			const auditInput: Parameters<typeof buildAuditRecord>[0] = {
				tool: call.tool,
				classification,
				decision: "allowed",
				args: call.args,
			};
			if (mode !== undefined) auditInput.mode = mode;
			const record = buildAuditRecord(auditInput);
			writeAudit(record);
			context.bus.emit(BusChannels.SafetyAllowed, {
				tool: call.tool,
				actionClass: classification.actionClass,
				mode,
			});
			return { kind: "allow", classification };
		},
		observeLoop(key, now) {
			const [next, verdict] = observeLoop(loopState, key, now ?? Date.now());
			loopState = next;
			return verdict;
		},
		scopes: { default: DEFAULT_SCOPE, readonly: READONLY_SCOPE, super: SUPER_SCOPE },
		isSubset,
		audit: { recordCount: () => recordCount },
	};

	return { extension, contract };
}

function serializeArgs(args?: Record<string, unknown>): string {
	if (!args) return "";
	const parts: string[] = [];
	for (const v of Object.values(args)) {
		if (v == null) continue;
		if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") parts.push(String(v));
		else {
			try {
				parts.push(JSON.stringify(v));
			} catch {
				// ignore values that cannot be serialized
			}
		}
	}
	return parts.join(" ");
}
