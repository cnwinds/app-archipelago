#!/bin/sh
# Prepare the server directory for docker compose. Safe to run again: it only fills in what is missing.
#
#   cd /opt/app-archipelago && sh scripts/server-init.sh
#
# Optional: ADMIN_USER=you ADMIN_PASSWORD=secret sh scripts/server-init.sh   (first run only)
set -e
cd "$(dirname "$0")/.."

OWNER="${DATA_UID:-1000}"

# The api runs as an unprivileged user and owns ./data (database, screenshots, published catalog).
mkdir -p data/shots data/public/catalog/shots data/backups secrets
chown -R "$OWNER:$OWNER" data

touch .env
if ! grep -q '^WORKER_TOKEN=' .env; then
  echo "WORKER_TOKEN=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')" >> .env
  echo "generated WORKER_TOKEN in .env"
fi

# Password for /admin/ (HTTP basic auth, checked by the nginx in the web container).
if [ ! -s secrets/admin.htpasswd ]; then
  NAME="${ADMIN_USER:-admin}"
  PASS="${ADMIN_PASSWORD:-$(head -c 9 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
  printf '%s:%s\n' "$NAME" "$(openssl passwd -apr1 "$PASS")" > secrets/admin.htpasswd
  chmod 644 secrets/admin.htpasswd
  echo "review page login (shown once): $NAME / $PASS"
fi

# The shared hosts of the server often need mirrors for the image build.
grep -q '^APK_MIRROR=' .env || echo "(tip: set APK_MIRROR=mirrors.aliyun.com in .env when building in mainland China)"
echo "ready"
