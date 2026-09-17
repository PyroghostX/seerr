#!/bin/bash
# Build the fork image and redeploy the `seerr` service from ~/Documents/docker-compose.yml.
# (Never run `docker compose` inside this repo: its own compose.yaml would start a second container.)
set -e
cd "$(dirname "$0")"
TAG=$(git rev-parse --short HEAD)-upgrade
docker build -q -t seerr-fork:upgrade --build-arg COMMIT_TAG="$TAG" .
docker rm -f seerr-seerr-1 >/dev/null 2>&1 || true
docker compose -f /home/kirby/Documents/docker-compose.yml --project-directory /home/kirby/Documents up -d seerr
timeout 90 bash -c 'until curl -sf http://localhost:5055/api/v1/status >/dev/null; do sleep 3; done'
curl -s http://localhost:5055/api/v1/status; echo

# Keep the host disk clean: every rebuild leaves layer cache and a dangling
# previous image behind (filled / to 94% on 2026-09-16). Drop them now.
docker image prune -f >/dev/null
docker builder prune -af >/dev/null
echo "cleanup done: $(docker system df --format '{{.Type}} reclaimable {{.Reclaimable}}' | tr '\n' '; ')"
