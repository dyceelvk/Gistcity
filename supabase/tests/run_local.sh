#!/usr/bin/env bash
# Runs the GistCity SQL tests on a throw-away PostgreSQL database.
#   local:  PGHOST=/tmp PGPORT=5433 PGUSER=postgres supabase/tests/run_local.sh
#   CI:     PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres supabase/tests/run_local.sh
# Exits non-zero if any migration or assertion fails.
set -euo pipefail
cd "$(dirname "$0")/../.."
DB=${GIST_TEST_DB:-gist_test}
PSQL=${PSQL:-psql}
export PGOPTIONS='-c client_min_messages=warning'
$PSQL -qc "drop database if exists $DB" postgres
$PSQL -qc "create database $DB" postgres
$PSQL -d "$DB" -v ON_ERROR_STOP=1 -q -c "create extension if not exists pgcrypto" -f supabase/tests/local_auth_stub.sql
for m in supabase/migrations/*.sql; do
  echo "applying $m"
  $PSQL -d "$DB" -v ON_ERROR_STOP=1 -q -f "$m"
done
echo "re-applying latest migration (idempotency)"
$PSQL -d "$DB" -v ON_ERROR_STOP=1 -q -f "$(ls supabase/migrations/*.sql | tail -1)"
for t in supabase/tests/*_test.sql; do
  echo "running $t"
  OUT=$(mktemp)
  if $PSQL -d "$DB" -v ON_ERROR_STOP=1 -q -t -f "$t" > "$OUT" 2>&1; then
    grep -v '^\s*$' "$OUT" || true; rm -f "$OUT"
  else
    grep -v '^\s*$' "$OUT" || true; rm -f "$OUT"
    echo "FAIL: a GistCity SQL test failed (see above)"; exit 1
  fi
done
