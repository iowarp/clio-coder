# Git Commit Provenance

Clio Coder adds evidence-aware role trailers to commits created through Clio.
The feature is enabled by default:

```yaml
attribution:
  gitCommits: true
```

Settings -> Advanced exposes the same switch as **Clio commit provenance**, with
`enabled` and `disabled` values. A change applies immediately to subsequent
commits in the session. When disabled, Clio leaves commit messages entirely
unchanged.

## Canonical identity

The identity is compiled into Clio and is not user-editable:

```text
Clio Coder <clio-coder@iowarp.ai>
```

Clio never replaces the human author or committer. The person and Git identity
that made the commit remain in the commit's author and committer fields.

## Evidence-dependent roles

Each trailer states what trusted execution evidence proves. A role is not an
advertisement and is never inferred from an agent saying in prose that it ran a
check or performed a review.

```text
Assisted-by: Clio Coder <clio-coder@iowarp.ai>
Tested-by: Clio Coder <clio-coder@iowarp.ai>
Reviewed-by: Clio Coder <clio-coder@iowarp.ai>
Co-authored-by: Clio Coder <clio-coder@iowarp.ai>
```

- `Assisted-by` means Clio materially created or edited work in the commit.
- `Tested-by` means an actual validation command completed successfully against
  the work. Prose that claims tests passed is not evidence.
- `Reviewed-by` means an independent verifier or reviewer produced a passing
  result. A self-review or an unsealed assertion is not enough.
- `Co-authored-by` is added only when Clio materially authored part of the
  change. GitHub and GitLab recognize this compatibility trailer for
  contributor and avatar display. Testing or review alone never adds it.

Existing human trailers stay in place. A Clio trailer already present in any
letter case is respected rather than repeated, line endings are normalized only
while attribution is enabled, and repeated processing is idempotent. When a directly relevant
receipt-v15 digest passes integrity verification, Clio may additionally add the
full digest:

```text
Clio-Evidence: receipt-v15/sha256:<64-character digest>
```

Clio does not invent, shorten, or add an unrelated digest. The role trailers do
not depend on this optional line.

## Commit paths and hooks

The deterministic SDLC fleet attributes its plan, code, and documentation
commits at the controlled commit seam. Material agent work supplies assistance
and authorship, successful deterministic code steps supply testing, and a
passing independent gate supplies review. Any later workspace mutation makes
prior testing and review stale; only validation or review that is fresh for the
commit can be claimed.

For Clio-controlled child processes, Clio supplies a process-local managed
hooks directory through command-scope Git configuration. The directory holds a
chaining wrapper for every hook name Git knows, so the repository's own
`pre-commit`, `commit-msg`, `pre-push`, and remaining default hooks still run
exactly as before with their original exit status. Only the `prepare-commit-msg`
wrapper adds anything, and only after the repository's own hook has run and
succeeded. It runs only when both `AI_AGENT=clio-coder` and the effective
attribution setting are present. It uses `git interpret-trailers`. Normal
commits from an external terminal do not receive Clio's managed hooks.

The child-process seams attribute by spawn provenance, not by sealed evidence.
A commit the agent itself runs through the Bash tool, a worker, or a registered
code step claims assistance and authorship, because it records the agent's own
session work. A commit made by a delegated external harness over ACP claims
assistance only, since that harness authored the change. A commit made by an
operator hook command claims nothing. Testing and review are never claimed at
these seams; only the fleet's coordinator-owned results can supply them.

The managed hook attributes only a message supplied up front with `-m`, `-F`,
or a merge. It skips amend, commit-message reuse, squash, cherry-pick, revert,
rebase, sequencer operations, and editor sessions, so historical messages are
not falsely attributed and an abandoned editor still aborts the commit.
`--no-verify` does not bypass `prepare-commit-msg`, matching Git's normal hook
semantics. The message is finalized at this stage before Git signs the commit,
so signed commits retain their existing behavior.

Clio never overwrites repository hooks or changes `core.hooksPath`. If a custom
hooks path or another setup cannot be composed safely, Clio fails open, emits a
bounded diagnostic, and relies on controlled commit seams such as the fleet
runner. Attribution failure does not destroy a commit; only a pre-existing hook
that already failed continues to block it.

## Platform identity and avatar prerequisite

Git commit data contains names and email addresses, not logos. GitHub and
GitLab obtain the displayed avatar from the platform account that has verified
the commit email. Before release, maintainers must verify
`clio-coder@iowarp.ai` on IOWarp-controlled GitHub and GitLab identities, for
example `clio-coder-bot` or `iowarp-clio`, and upload the existing Clio logo as
the account avatar. `assets/clio-coder-avatar-512.png` is an exact PNG
conversion of the existing 512 px Clio logo for platforms that require PNG.
No account creation or remote operation is performed by Clio Coder.
