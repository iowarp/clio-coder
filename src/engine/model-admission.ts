import type { ModelAdmissionReporter } from "../core/model-admission.js";

/** Internal request option carried through adapter spreads without reaching provider payloads. */
export const MODEL_ADMISSION = Symbol("clio-coder.model-admission");

type AdmissionOptions = { [MODEL_ADMISSION]?: ModelAdmissionReporter };

/** The reporter this request's owner attached. Side calls, probes and workers attach none, and stay silent. */
export function modelAdmissionReporter(options: object | undefined): ModelAdmissionReporter | undefined {
	return options === undefined ? undefined : (options as AdmissionOptions)[MODEL_ADMISSION];
}
