#!/bin/sh
# Global git hook dispatcher
# Runs all executable scripts in <stage>.d/ then delegates to repo-local hook.
# Usage: source this file, then call: _dispatch <stage> "$@"

_dispatch() {
	_stage="$1"
	shift
	_global_d="$(dirname "$0")/${_stage}.d"
	_local_hook="$(git rev-parse --git-dir 2>/dev/null)/hooks/${_stage}"

	# 1. Run global .d/ hooks (sorted order)
	if [ -d "$_global_d" ]; then
		for _hook in "$_global_d"/*; do
			[ -x "$_hook" ] || continue
			"$_hook" "$@"
			_rc=$?
			if [ $_rc -ne 0 ]; then
				echo "hook failed: $(basename "$_hook")" >&2
				exit $_rc
			fi
		done
	fi

	# 2. Delegate to repo-local hook if it exists
	if [ -x "$_local_hook" ]; then
		exec "$_local_hook" "$@"
	fi
}
