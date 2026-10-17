#!/bin/sh
# Customers per region, from the nightly signups export.
# Usage: scripts/customers_by_region.sh [REGION]
if [ -n "$1" ]; then
  awk -F, -v r="$1" 'NR>1 && $4==r {n++} END {print n+0}' analytics/signups.csv
else
  awk -F, 'NR>1 {n[$4]++} END {for (r in n) print r, n[r]}' analytics/signups.csv
fi
