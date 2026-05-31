#!/bin/bash
# Sink - CouchDB Server Setup
# Run this after `docker compose up -d` to initialize the database.

set -e

# Safely load .env without exposing credentials to process list
if [ -f .env ]; then
  set -a
  # shellcheck source=.env
  source .env
  set +a
fi

USER="${COUCHDB_USER:-admin}"
PASS="${COUCHDB_PASSWORD}"

if [ -z "$PASS" ]; then
  echo "Error: COUCHDB_PASSWORD not set. Create a .env file or export it."
  exit 1
fi

COUCH="http://${USER}:${PASS}@localhost:5985"

echo "Waiting for CouchDB to be ready..."
until curl -sf "http://localhost:5985/" > /dev/null 2>&1; do
  sleep 1
done

echo "Creating system databases..."
curl -sf -X PUT "$COUCH/_users" > /dev/null 2>&1 || true
curl -sf -X PUT "$COUCH/_replicator" > /dev/null 2>&1 || true
curl -sf -X PUT "$COUCH/_global_changes" > /dev/null 2>&1 || true

echo "Creating sink database..."
curl -sf -X PUT "$COUCH/sink" > /dev/null 2>&1 || true

echo ""
echo "=== Sink server ready! ==="
echo "CouchDB URL (on server):  http://localhost:5985"
echo "Database:                 sink"
echo "Fauxton UI (via Tailscale): http://$(tailscale ip -4 2>/dev/null || echo '<tailscale-ip>'):5985/_utils"
echo ""
echo "Use your Tailscale IP to connect from other devices:"
echo "  http://<tailscale-ip>:5985"
