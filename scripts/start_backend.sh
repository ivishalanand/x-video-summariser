#!/bin/bash
# Wrapper for launchd — sources .env without echoing secrets, then runs uvicorn.
cd "$(dirname "$0")/../backend"
set -a
. ./.env
set +a
exec "$HOME/.x_summariser_venv/bin/uvicorn" main:app --port 47291
