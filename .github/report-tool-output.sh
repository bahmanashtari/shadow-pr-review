#!/usr/bin/env bash
# Puts a step's output where somebody without admin rights on the repository can read it
# (ADR-056): the job summary, and - when the step failed - an `::error::` annotation, which the
# checks API serves to anyone. A failed job's log needs admin rights, and its annotations
# otherwise say only "exit code 1", which is how two workflow defects took a run each to find.
#
#   report-tool-output.sh <log file> <exit code>
set -euo pipefail

log="$1"
code="${2:-0}"

{
  echo '```'
  tail -c 60000 "$log"
  echo '```'
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
tail -n 40 "$log"

if [ "$code" -ne 0 ]; then
  # Annotations are one line: real newlines are encoded, and the message is kept well under
  # GitHub's 4 KB limit. awk rather than sed, whose multiline idiom differs between GNU and BSD.
  message=$(tail -n 15 "$log" | tail -c 3000 |
    awk '{ gsub(/%/, "%25"); gsub(/\r/, "%0D"); printf "%s%%0A", $0 }')
  echo "::error title=spr exited $code::$message"
  exit "$code"
fi
