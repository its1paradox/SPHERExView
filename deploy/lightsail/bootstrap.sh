#!/usr/bin/env bash
# Run as root from a reviewed, pinned checkout on Ubuntu 24.04.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y docker.io docker-compose-v2 ca-certificates curl unattended-upgrades
systemctl enable --now docker

# Build-time headroom on the 2 GiB plan; uses the included root disk.
if ! test -e /swapfile; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
fi
if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
    swapon /swapfile
fi
if ! grep -q '^/swapfile ' /etc/fstab; then
    printf '/swapfile none swap sw 0 0\n' >> /etc/fstab
fi
install -d -m 0750 -o 10001 -g 10001 /srv/spherexview/data
install -d -m 0700 /srv/spherexview/caddy-data /srv/spherexview/caddy-config
cd "$(dirname "$0")"
docker compose config --quiet
docker compose build
docker compose up -d --wait --wait-timeout 240
curl --fail --retry 6 --retry-delay 5 http://127.0.0.1:10000/api/health
printf '\nSPHERExView bootstrap completed\n'
