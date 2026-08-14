# Fixture: write boundary

A step that escapes its declared `writes` allowlist, made deterministic so the
reading does not depend on talking a model into misbehaving.

`.clio-coder/fleets/commands.yaml` declares two registry commands. `leak` writes
`out/leak.txt`; `leak-dirty` overwrites `out/preexisting.txt`. Both fleet
contracts declare `writes: ["src/"]` on the step that runs them, so every run
violates the boundary and both commands exit 0: the step must fail because of
the boundary, not because the command failed.

Two paths, because they end differently.

`boundary-leak` is the recoverable one. `out/leak.txt` did not exist at the
baseline commit, so git knows exactly what restoration means and the verdict is
`rolled-back` with the file gone.

`boundary-dirty` is the honest failure. The suite's setup commits
`out/preexisting.txt` and then leaves it modified, so its pre-step bytes exist
nowhere but the tree the step overwrites. Rollback reports
`rollback-incomplete`, leaves the working tree exactly as the step made it, and
records the path and the reason. A rollback that guessed at content it never
recorded would destroy work.

Enforcement is detect-and-rollback, never sandboxing. Nothing here prevents a
write, and the fixture does not pretend otherwise: it measures whether Clio saw
the write, named it `writes_boundary_violation`, restored what git could
restore, and sealed a verdict carrying its own digest and the baseline commit
it was computed against.

`test/known-answers.test.mjs <mode>` reads the tree the verdict claims to
describe. The metrics read the verdict. A verdict that says `rolled-back`
beside a file still on disk fails one of the two.
