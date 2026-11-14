#!/bin/bash
# Reachability of each work from the machine this runs on. Meant for a server inside
# mainland China, to estimate what visitors there can actually open.
#
#   bash reach.sh urls.txt     (one "<id> <url>" per line)  ->  "<id> <http_code> <seconds>"
#
# http_code 000 means no response within the time limit.
probe() {
  local out
  out=$(curl -sS -L -o /dev/null -m 15 -A 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130 Safari/537.36' \
    -w '%{http_code} %{time_total}' "$2" 2>/dev/null)
  echo "$1 ${out:-000 15}"
}
export -f probe
grep -v '^\s*$' "$1" | xargs -P 8 -L 1 bash -c 'probe "$0" "$1"'
