import { AppProblem } from "../services/problem.js";
import { projectSessionConfigOptions } from "./session-config-model.js";

export function projectConfigOptions(raw: unknown) {
	const options = projectSessionConfigOptions(raw);
	if (options === null) throw new AppProblem("upstream_acp", "Clio Coder returned invalid session configuration.");
	return options;
}
