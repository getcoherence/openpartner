#!/usr/bin/env bash
# Provision the openpartner_app role on first container boot.
#
# This runs once when the postgres container's data volume is empty
# (the standard /docker-entrypoint-initdb.d behavior). Subsequent
# starts do nothing — to rotate the password, recreate the volume or
# run the migration `20260507020000_app_role.ts` against an existing
# DB, which idempotently rotates.
#
# The role is created NOLOGIN if OPENPARTNER_APP_DB_PASSWORD is unset,
# so RLS isolation can still be verified in tests via SET ROLE without
# providing a password. For a real RLS-enforcing setup, set the env
# var when bringing up the stack.
#
# DML grants are issued by the migration, not here, so this script
# stays valid even as new tables are added.

set -euo pipefail

PASSWORD="${OPENPARTNER_APP_DB_PASSWORD:-}"

if [ -z "$PASSWORD" ]; then
  echo "[initdb] OPENPARTNER_APP_DB_PASSWORD unset — creating openpartner_app NOLOGIN."
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-'EOSQL'
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpartner_app') THEN
        CREATE ROLE openpartner_app NOLOGIN;
      END IF;
    END
    $$;
EOSQL
else
  echo "[initdb] Creating openpartner_app with login + password from env."
  psql -v ON_ERROR_STOP=1 -v app_pwd="$PASSWORD" --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-'EOSQL'
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpartner_app') THEN
        EXECUTE format('CREATE ROLE openpartner_app LOGIN PASSWORD %L', :'app_pwd');
      ELSE
        EXECUTE format('ALTER ROLE openpartner_app LOGIN PASSWORD %L', :'app_pwd');
      END IF;
    END
    $$;
EOSQL
fi
