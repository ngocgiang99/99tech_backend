#!/bin/sh
set -e

echo "[entrypoint] Running database migrations..."
node_modules/.bin/kysely migrate:latest

echo "[entrypoint] Starting application..."
exec node dist/index.js
