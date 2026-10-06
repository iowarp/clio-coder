---
description: Save the current research position and pause active work.
---

Read ${component:resource:research-policy}; inspect WORKFLOW/STATE and partial artifacts.
Ask for missing continuation facts. Through gateway, call `extension_materio__record_decision`
with decision (prepared work, pending physical work, missing inputs, exact next action), rationale and scope "Task NN".
Call `extension_materio__set_task_status` with `{task:<id>,status:"paused"}`; stop on refusal.
Save `/materio:checkpoint save paused`, verify its receipt, show continuation and offer resume-research.
Never claim unfinished results or change task identity.
If runtime is unavailable, follow ${pluginRoot}/assets/actions/pause-research.md manually with gates and readback.
