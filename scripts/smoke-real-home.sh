#!/usr/bin/env bash
# Real-home release smoke: boot the built binary against a copy of the
# operator's own settings instead of an isolated fixture home.
#
# The 0.4.2 release smoke ran only with isolated homes and missed two bugs
# that a real settings file exposed on first launch (a raised
# safety.limits.readBytesPerCall refusing to boot, and a legacy skill
# metadata key warning at boot). This runs `doctor` and one headless turn
# with a copy of ~/.config/clio-coder/settings.yaml (and credentials.yaml when
# present) in a scratch CLIO_CODER_HOME that is deleted afterwards. The real
# home is never written. Fails on a doctor crash or deprecation warning, on a
# turn that exits non-zero, refuses to boot (tool policy drift), or ends with
# no agent_end event; doctor's own failing rows are printed for the operator.
#
# Usage: scripts/smoke-real-home.sh [--settings <path>] [--target <id>] [--model <wireId>]
#   --settings  settings file to copy (default: the platform config dir's settings.yaml)
#   --target    one-run target override for the turn (default: the settings' orchestrator target)
#   --model     one-run model override for the turn
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cli="$root/dist/cli/index.js"
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/clio-coder"
settings="$config_dir/settings.yaml"
target=""
model=""
while [ $# -gt 0 ]; do
	case "$1" in
		--settings) settings="$2"; shift 2 ;;
		--target) target="$2"; shift 2 ;;
		--model) model="$2"; shift 2 ;;
		*) echo "smoke-real-home: unknown argument $1" >&2; exit 2 ;;
	esac
done

if [ ! -f "$cli" ]; then
	echo "smoke-real-home: $cli is missing; run npm run build first" >&2
	exit 2
fi
if [ ! -f "$settings" ]; then
	echo "smoke-real-home: no settings file at $settings; pass --settings <path>" >&2
	exit 2
fi

scratch="$(mktemp -d "${TMPDIR:-/tmp}/clio-coder-real-home-smoke.XXXXXX")"
chmod 700 "$scratch"
cleanup() { rm -rf "$scratch"; }
trap cleanup EXIT
mkdir -p "$scratch/home/config" "$scratch/project"
cp "$settings" "$scratch/home/config/settings.yaml"
if [ -f "$(dirname "$settings")/credentials.yaml" ]; then
	cp "$(dirname "$settings")/credentials.yaml" "$scratch/home/config/credentials.yaml"
fi
export CLIO_CODER_HOME="$scratch/home"
cd "$scratch/project"
git init -q

echo "smoke-real-home: settings copied from $settings into $CLIO_CODER_HOME"
failures=0

# A copied settings file lands in a home Clio has never initialized, so the
# data, state and cache roots and the state metadata are created first, the
# way a real home already has them. --fix writes only inside the scratch home.
node "$cli" doctor --fix >/dev/null 2>&1 || true

# doctor's own failing rows (an unadvertised model id, a node that is down)
# are fleet state the operator reads, not a smoke failure; the smoke fails on
# the things a fixture home cannot show: a crash, a deprecation warning, or a
# usage error.
doctor_log="$scratch/doctor.log"
doctor_status=0
node "$cli" doctor >"$doctor_log" 2>&1 || doctor_status=$?
if [ "$doctor_status" -ge 2 ]; then
	echo "smoke-real-home: doctor exited $doctor_status"
	failures=$((failures + 1))
elif [ "$doctor_status" -eq 1 ]; then
	echo "smoke-real-home: doctor exited 1 with these failing rows (fleet state, not a smoke failure):"
	grep -E "^!!" "$doctor_log" || true
else
	echo "smoke-real-home: doctor exited 0"
fi
if grep -q "DeprecationWarning" "$doctor_log"; then
	echo "smoke-real-home: doctor printed a deprecation warning:"
	grep "DeprecationWarning" "$doctor_log"
	failures=$((failures + 1))
fi
if grep -qE "^\s+at .*\.js:[0-9]+" "$doctor_log"; then
	echo "smoke-real-home: doctor printed a stack trace:"
	grep -B2 -E "^\s+at .*\.js:[0-9]+" "$doctor_log" | head -12
	failures=$((failures + 1))
fi
grep -E "^WARN" "$doctor_log" || true

turn_out="$scratch/turn.jsonl"
turn_err="$scratch/turn.err"
run_args=(run --autonomy read-only --json)
[ -n "$target" ] && run_args+=(--target "$target")
[ -n "$model" ] && run_args+=(--model "$model")
run_args+=("Reply with the single word ready.")
if node "$cli" "${run_args[@]}" >"$turn_out" 2>"$turn_err"; then
	echo "smoke-real-home: turn exited 0"
else
	echo "smoke-real-home: turn exited $?"
	failures=$((failures + 1))
fi
if grep -q "DeprecationWarning\|tool policy drift" "$turn_err"; then
	echo "smoke-real-home: turn stderr carries a boot problem:"
	grep "DeprecationWarning\|tool policy drift" "$turn_err"
	failures=$((failures + 1))
fi
if grep -q '"type":"agent_end"' "$turn_out"; then
	echo "smoke-real-home: agent_end $(grep '"type":"agent_end"' "$turn_out" | tail -1 | cut -c1-300)"
else
	echo "smoke-real-home: no agent_end event in the turn stream; stderr tail:"
	tail -20 "$turn_err"
	failures=$((failures + 1))
fi

if [ "$failures" -gt 0 ]; then
	echo "smoke-real-home: FAILED ($failures problems); doctor output follows"
	cat "$doctor_log"
	exit 1
fi
echo "smoke-real-home: ok"
