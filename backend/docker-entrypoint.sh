#!/bin/sh
# Start as root just long enough to give the "app" user the writable mounts
# (which may have been created by an older, root-run image), then drop to it.
set -e
if [ "$(id -u)" = "0" ]; then
    for dir in /app/models /app/logs /app/data /app/.ultralytics; do
        mkdir -p "$dir"
        chown -R app:app "$dir" 2>/dev/null || echo "entrypoint: could not chown $dir" >&2
    done
    # HOME follows the user: libraries look for per-user config there (asyncpg
    # reads ~/.postgresql), and /root is not readable once privileges are gone.
    export HOME=/home/app
    exec setpriv --reuid=app --regid=app --init-groups "$@"
fi
exec "$@"
