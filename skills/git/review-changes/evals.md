# Evals — review-changes

Baseline scenarios (subagent WITHOUT the skill vs WITH). Pass/fail per
bullet. Fixtures seed a real git repo in the eval workspace (repo-relative
shell only). Expected bullets describe transcript-observable behavior; a
bullet passes only when the treatment transcript shows it.

## S1 — seeded bug in a diff
Setup: review my changes before I commit.

Fixture:
```bash
git init -q .
git branch -M main
git config user.email eval@clio.local
git config user.name "Clio Eval"
git config commit.gpgsign false
printf 'function lastItems(items, n) {\n  return items.slice(items.length - n);\n}\nmodule.exports = { lastItems };\n' > items.js
git add items.js
git commit -qm "chore: seed items module"
printf 'const API_KEY = "sk-live-9f8e7d6c5b4a3210fedcba9876543210";\n\nfunction lastItems(items, n) {\n  const out = [];\n  for (let i = items.length - n; i <= items.length; i++) {\n    out.push(items[i]);\n  }\n  return out;\n}\nmodule.exports = { lastItems, API_KEY };\n' > items.js
```

Expected:
- Reads the changed file in full (a read of `items.js`), not only the diff
  hunks.
- Finds both seeded problems: the loop bound reads past the array end
  (`i <= items.length`), and the hardcoded API key; the key is reported at
  CRITICAL severity.
- Each finding carries file, line, detail, suggestion, and a verification
  status.
- A report is written under `.clio/reviews/` and summarized to the user;
  `items.js` is never edited.

## S2 — clean diff
Setup: review my changes before I commit.

Fixture:
```bash
git init -q .
git branch -M main
git config user.email eval@clio.local
git config user.name "Clio Eval"
git config commit.gpgsign false
printf 'function greet(name) {\n  return "Hello, " + name;\n}\nmodule.exports = { greet };\n' > greet.js
git add greet.js
git commit -qm "chore: seed greeter"
printf 'function greet(name) {\n  return "Hello, " + String(name).trim();\n}\nmodule.exports = { greet };\n' > greet.js
```

Expected:
- Concludes the review passed with no verified technical issues; no
  manufactured findings and no formatting nitpicks presented as findings.

## S3 — convention trap
Setup: review my changes before I commit.

Fixture:
```bash
git init -q .
git branch -M main
git config user.email eval@clio.local
git config user.name "Clio Eval"
git config commit.gpgsign false
printf '# Contributing\n\nProject convention: error helpers return frozen plain objects carrying an err tag. Never throw or return Error instances from helpers.\n' > CONTRIBUTING.md
printf 'function ok(value) {\n  return Object.freeze({ err: null, value });\n}\nmodule.exports = { ok };\n' > result.js
git add CONTRIBUTING.md result.js
git commit -qm "chore: seed result helpers"
printf 'function ok(value) {\n  return Object.freeze({ err: null, value });\n}\nfunction fail(code) {\n  return Object.freeze({ err: code, value: null });\n}\nmodule.exports = { ok, fail };\n' > result.js
```

Expected:
- Loads project context/conventions (reads CONTRIBUTING.md or equivalent)
  before judging the diff; raises no finding against the documented
  frozen-object error convention.

## Baseline failure modes to watch for (RED)
- Formatting nitpicks presented as findings.
- Unverified speculation labeled critical.
- Editing the code under review.
