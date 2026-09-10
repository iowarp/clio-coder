#!/usr/bin/env bash
# Verify that the canonical library/ sources really install into Claude Code and
# really load in Codex, using the locally installed host CLIs.
#
# Everything runs in throwaway HOME/config directories under a scratch root, so
# the operator's own Claude and Codex installations are never read or mutated.
# No network, no auth and no model call is needed: marketplace sources are
# relative paths inside this repository, and Codex discovery is read through
# `codex debug prompt-input`, which renders the model-visible prompt locally.
#
# Usage: scripts/verify-portable-hosts.sh [output-directory]
#
# The log lands in the given directory, or under TMPDIR when none is named.
#
# This is evidence, not a unit test. `tests/contracts/library-portability.test.ts`
# holds the checks that must pass without a host binary present.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-${TMPDIR:-/tmp}/clio-coder-portability-evidence}"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/clio-coder-portability.XXXXXX")"
mkdir -p "${OUT_DIR}"

FAILURES=0
note() { printf '\n=== %s ===\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
pass() { printf 'PASS: %s\n' "$1"; }

cleanup() { rm -rf "${WORK_DIR}"; }
trap cleanup EXIT

# Everything is read from REPO_ROOT, never the caller's working directory, so
# the script behaves the same however it is invoked. The expected counts are
# derived from the repository rather than hardcoded, so adding a curated skill
# does not turn this evidence run into a false failure.
MARKETPLACE="${REPO_ROOT}/.claude-plugin/marketplace.json"
EXPECTED_ENTRIES="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).plugins.length))' "${MARKETPLACE}" 2>/dev/null)"
EXPECTED_SKILLS="$(find "${REPO_ROOT}/library/skills" -mindepth 3 -maxdepth 3 -name SKILL.md | wc -l | tr -d ' ')"
EXPECTED_MATERIO_SKILLS="$(find "${REPO_ROOT}/library/plugins/materio/skills" -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l | tr -d ' ')"

# ---------------------------------------------------------------------------
# Claude Code
# ---------------------------------------------------------------------------
run_claude() {
  local probe_home="${WORK_DIR}/claude-home"
  mkdir -p "${probe_home}/.claude"
  env -i \
    HOME="${probe_home}" \
    PATH="${PATH}" \
    CLAUDE_CONFIG_DIR="${probe_home}/.claude" \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    TERM=dumb \
    "$@"
}

claude_evidence() {
  note "host versions"
  claude --version || fail "claude --version"

  note "claude plugin validate . --strict --json"
  local validate
  validate="$(cd "${REPO_ROOT}" && run_claude claude plugin validate . --strict --json 2>&1)"
  printf '%s\n' "${validate}"
  if printf '%s' "${validate}" | grep -q '"success": true'; then
    pass "marketplace manifest validates in strict mode"
  else
    fail "marketplace manifest failed strict validation"
  fi

  note "claude plugin marketplace add ./ (isolated home)"
  (cd "${REPO_ROOT}" && run_claude claude plugin marketplace add ./) || fail "marketplace add"
  run_claude claude plugin marketplace list --json

  note "installing every marketplace entry"
  local names installed=0
  names="$(node -e 'for (const p of JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).plugins) console.log(p.name)' "${MARKETPLACE}")"
  for name in ${names}; do
    if (cd "${REPO_ROOT}" && run_claude claude plugin install "${name}@clio-coder" -y >/dev/null 2>&1); then
      installed=$((installed + 1))
    else
      fail "install ${name}@clio-coder"
    fi
  done
  printf 'installed %s of %s entries\n' "${installed}" "${EXPECTED_ENTRIES}"
  [ "${installed}" = "${EXPECTED_ENTRIES}" ] && pass "all ${EXPECTED_ENTRIES} entries installed" || fail "not every entry installed"

  note "claude plugin list --json"
  run_claude claude plugin list --json

  note "component inventory of every installed plugin"
  # Each entry is checked against the layout its own source actually has, so a
  # future bundle entry is not judged by the standalone-skill rule.
  local single_skill=0
  for name in ${names}; do
    local details source
    details="$(run_claude claude plugin details "${name}" 2>&1)"
    source="$(node -e '
      const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const e = m.plugins.find((p) => p.name === process.argv[2]);
      process.stdout.write(e ? e.source : "");
    ' "${MARKETPLACE}" "${name}")"
    printf -- '--- %s (%s) ---\n%s\n' "${name}" "${source}" "${details}"
    if [ -d "${REPO_ROOT}/${source}/skills" ]; then
      local bundled
      bundled="$(find "${REPO_ROOT}/${source}/skills" -mindepth 2 -maxdepth 2 -name SKILL.md | wc -l | tr -d ' ')"
      printf '%s' "${details}" | grep -q "Skills (${bundled})" \
        && pass "${name} publishes its ${bundled} portable skills" \
        || fail "${name} skill count: expected ${bundled}"
      printf '%s' "${details}" | grep -q "Agents (0)" \
        && pass "${name} exposes no host-native agents" \
        || fail "${name} leaked Clio-native agents into the host"
    elif printf '%s' "${details}" | grep -q "Skills (1)  ${name}"; then
      single_skill=$((single_skill + 1))
    else
      fail "${name} did not load its root SKILL.md under its canonical name"
    fi
  done
  printf 'root-SKILL.md packages loading under their canonical name: %s of %s\n' "${single_skill}" "${EXPECTED_SKILLS}"
  [ "${single_skill}" = "${EXPECTED_SKILLS}" ] && pass "all ${EXPECTED_SKILLS} skill packages load" || fail "skill package count"

  note "companion files survive the copied install"
  local cache="${WORK_DIR}/claude-home/.claude/plugins/cache/clio-coder"
  for probe in \
    "ast-grep/*/references/rule_reference.md" \
    "tdd/*/references/tests.md" \
    "materio/*/assets/scripts/research_state.py" \
    "materio/*/assets/references/research-policy.md"; do
    # shellcheck disable=SC2086
    if compgen -G "${cache}/${probe}" >/dev/null; then
      pass "installed copy carries ${probe}"
    else
      fail "installed copy is missing ${probe}"
    fi
  done
  if compgen -G "${cache}/*/*/_authoring" >/dev/null; then
    fail "an authoring template reached an installed package"
  else
    pass "no authoring template reached an installed package"
  fi
}

# ---------------------------------------------------------------------------
# Claude Code, against the packed npm tarball rather than the working tree
# ---------------------------------------------------------------------------
tarball_evidence() {
  note "npm pack, then add the installed package as a marketplace"
  local stage="${WORK_DIR}/tarball"
  mkdir -p "${stage}"
  local tarball
  tarball="$(cd "${REPO_ROOT}" && npm pack --pack-destination "${stage}" --ignore-scripts 2>/dev/null | tail -1)"
  if [ -z "${tarball}" ] || [ ! -f "${stage}/${tarball}" ]; then
    fail "npm pack produced no tarball"
    return
  fi
  printf 'packed %s\n' "${tarball}"
  tar -xzf "${stage}/${tarball}" -C "${stage}"
  local pkg="${stage}/package"
  if [ -f "${pkg}/.claude-plugin/marketplace.json" ]; then
    pass "tarball ships .claude-plugin/marketplace.json"
  else
    fail "tarball is missing .claude-plugin/marketplace.json"
    return
  fi
  local skills
  skills="$(find "${pkg}/library/skills" -mindepth 3 -maxdepth 3 -name SKILL.md | wc -l | tr -d ' ')"
  printf 'tarball carries %s curated SKILL.md files\n' "${skills}"
  [ "${skills}" = "${EXPECTED_SKILLS}" ] && pass "tarball carries all ${EXPECTED_SKILLS} skills" || fail "tarball skill count"

  local probe_home="${WORK_DIR}/tarball-home"
  mkdir -p "${probe_home}/.claude"
  local run=(env -i HOME="${probe_home}" PATH="${PATH}" CLAUDE_CONFIG_DIR="${probe_home}/.claude"
             CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 TERM=dumb)
  (cd "${pkg}" && "${run[@]}" claude plugin marketplace add ./) || fail "tarball marketplace add"
  (cd "${pkg}" && "${run[@]}" claude plugin install tdd@clio-coder -y) || fail "tarball install tdd"
  local details
  details="$("${run[@]}" claude plugin details tdd 2>&1)"
  printf '%s\n' "${details}"
  printf '%s' "${details}" | grep -q "Skills (1)  tdd" \
    && pass "a skill installs from the packed npm package" \
    || fail "the packed package did not resolve its marketplace sources"
}

# ---------------------------------------------------------------------------
# Codex
# ---------------------------------------------------------------------------
codex_evidence() {
  note "codex --version"
  codex --version || fail "codex --version"

  local probe_home="${WORK_DIR}/codex-home"
  mkdir -p "${probe_home}/.codex"
  note "codex debug prompt-input from the repository root (isolated HOME)"
  local prompt
  prompt="$(cd "${REPO_ROOT}" && env -i HOME="${probe_home}" PATH="${PATH}" CODEX_HOME="${probe_home}/.codex" TERM=dumb \
    codex debug prompt-input 2>/dev/null)"
  printf '%s' "${prompt}" | node -e '
    let raw = "";
    process.stdin.on("data", (c) => { raw += c; });
    process.stdin.on("end", () => {
      const data = JSON.parse(raw.slice(raw.indexOf("[")));
      const text = data[0].content[0].text;
      const roots = [...text.matchAll(/- `(r\d+)` = `([^`]+)`/g)].map((m) => `${m[1]} = ${m[2]}`);
      const skills = [...text.matchAll(/^- ([a-z0-9-]+): .*?\(file: (\S+)\)$/gm)].map((m) => [m[1], m[2]]);
      console.log("skill roots:");
      for (const root of roots) console.log("  " + root);
      console.log("discovered skills:");
      for (const [name, file] of skills) console.log(`  ${name}  ${file}`);
      const curated = skills.filter(([, f]) => f.includes("/clio-coder/"));
      const materio = skills.filter(([, f]) => f.includes("/materio/"));
      console.log(`curated=${curated.length} materio=${materio.length}`);
    });
  ' > "${WORK_DIR}/codex-skills.txt" 2>&1
  cat "${WORK_DIR}/codex-skills.txt"
  local counts
  counts="$(grep -o 'curated=[0-9]* materio=[0-9]*' "${WORK_DIR}/codex-skills.txt" | tail -1)"
  if [ "${counts}" = "curated=${EXPECTED_SKILLS} materio=${EXPECTED_MATERIO_SKILLS}" ]; then
    pass "Codex discovers ${EXPECTED_SKILLS} curated and ${EXPECTED_MATERIO_SKILLS} Materio skills through .agents/skills"
  else
    fail "Codex discovery counts: ${counts}"
  fi
  if grep -q "ai.iowarp.clio" "${WORK_DIR}/codex-skills.txt"; then
    fail "Codex was offered a Clio-native resource"
  else
    pass "Codex sees only portable skills"
  fi
}

{
  printf 'clio-coder outbound portability evidence\n'
  printf 'date: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'repo: %s\n' "${REPO_ROOT}"
  printf 'commit: %s\n' "$(git -C "${REPO_ROOT}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  printf 'marketplace entries: %s\n' "${EXPECTED_ENTRIES}"
  claude_evidence
  tarball_evidence
  codex_evidence
  note "summary"
  printf 'failures: %s\n' "${FAILURES}"
} 2>&1 | tee "${OUT_DIR}/host-verification.log"

exit "$(grep -c '^FAIL: ' "${OUT_DIR}/host-verification.log" || true)"
