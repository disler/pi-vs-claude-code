#!/usr/bin/env bash
# Source this file to add portable IDC Pi Network shell helpers.
# Usage: source scripts/pi-idc-aliases.sh

export PI_IDC_HARNESS_REPO="${PI_IDC_HARNESS_REPO:-/Users/jeremy/dev/proj/pi-vs-claude-code}"

_idc_pi() {
	"$PI_IDC_HARNESS_REPO/scripts/idc-pi" "$@"
}

idc-pi()          { _idc_pi "$@"; }
idc-coms-server() { _idc_pi server "$@"; }
idc-open-all()      { _idc_pi open-all "$@"; }
idc-open()          { _idc_pi open "$@"; }
idc-open-all-cmux() { _idc_pi open-all-cmux "$@"; }
idc-open-cmux()     { _idc_pi open-cmux "$@"; }
idc-run()           { _idc_pi run "$@"; }

# V1-compatible role helper names, now portable from the caller's cwd.
pi-think()        { _idc_pi run think "$@"; }
pi-plan()         { _idc_pi run plan "$@"; }
pi-sequence()     { _idc_pi run sequence "$@"; }
pi-ripple()       { _idc_pi run ripple "$@"; }
pi-build-impl()   { _idc_pi run build-impl "$@"; }
pi-build-review() { _idc_pi run build-review "$@"; }
pi-build-finish() { _idc_pi run build-finish "$@"; }
