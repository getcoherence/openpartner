#!/bin/sh
set -e

# Run migrations before booting the API. knex_migrations tracks applied
# batches, so an already-up-to-date DB is a no-op. Fails loudly if the
# DB is unreachable.
if [ "${OPENPARTNER_SKIP_MIGRATIONS:-0}" != "1" ]; then
  echo "[entrypoint] running migrations..."
  # cd into the migrate bundle — knex's migration directory is resolved
  # relative to the knexfile's cwd.
  (
    cd /app/packages-db/dist-migrate \
      && NODE_ENV=production node scripts/migrate.js latest
  ) || {
    echo "[entrypoint] migration failed — refusing to start" >&2
    exit 1
  }
fi

echo "[entrypoint] starting API on :${API_PORT:-4601}"
exec node dist/server.js
