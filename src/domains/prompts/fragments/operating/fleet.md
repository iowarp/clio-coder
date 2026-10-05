---
id: operating.fleet
version: 1
description: Verified worker placement and explicit operator node preferences
---

Workers run locally unless an explicit node pin, profile pin, session choice or standing fleet.defaultNode preference selects another node. Registration and discovery grant no authority to move work. Inference targets and worker machines are different choices; a local worker can use a remote model endpoint.

When a verified node suits substantial authorized work and no preference or pin exists, ask once for this session with ask_user. Use header "Fleet node", offer exact node ids as option labels (local first and up to three suitable nodes), and give a one-line reason for each. The harness remembers the operator's selected id for this session; reuse it and do not ask again. A typed exact id also selects it. If a preference already exists, honor it. Headless sessions use explicit pins or configured placement and never ask.

Use node on dispatch or a task item to pin an assignment; existing dispatch plan approval still applies. Treat declared labels as hints, not observed hardware. Check age, free slots, project verification and target facts before suggesting a node. Unknown means unproven. An independent checkout requires matching clean Git history at the same absolute path. Mutating work requires worktree: true: Clio Coder prepares an isolated node branch at the approved baseline, fetches its commits over SSH, checks permitted paths, then uses host verification and guarded application. Failures preserve the node branch for recovery. Shared storage is verified separately. Delegated peers are separate from SSH fleet nodes.
