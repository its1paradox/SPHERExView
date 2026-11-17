# Lightsail public pilot

Approved infrastructure: one Ubuntu 24.04 Linux dual-stack Lightsail instance,
2 GiB RAM / 2 vCPUs / 60 GB SSD, $12/month before tax and excess usage, in
us-west-2 (Oregon). Attach one static IPv4 address. Paid snapshots, managed
databases, load balancers and CDN are not part of this deployment.

The app and built frontend run in one container with one Uvicorn process;
Caddy provides the public reverse proxy and automatic HTTPS when DNS is ready.
The science dependencies and public admission controls are shared with the
previous Render package. See RENDER_DEPLOYMENT.md for the science validation
and pilot limitations. Never start multiple app workers: admission/job state
is in memory. This single-server pilot has no high availability or backup yet.

## Install

Clone the repository to /opt/spherexview, check out a reviewed exact commit,
then run `sudo bash deploy/lightsail/bootstrap.sh`. Installation adds 2 GiB
swap on the included disk and uses Ubuntu's packaged Docker/Compose.
The app runs as UID 10001 with a read-only container filesystem, temporary
/tmp, and writable persistent /srv/spherexview/data mounted at /var/data.
Timeline observation counts are uncapped in the updated source. See
[full-inventory batching](TIMELINE_BATCHING.md) for storage, validation and
failure reporting. Deploy the reviewed PR commit to activate this on AWS.

Container logs rotate. The app has a 1400 MiB memory limit; this is a bounded
pilot and large jobs can still exhaust memory. Caddy has a 128 MiB limit.

Lightsail wraps launch scripts with `/bin/sh`: a Bash shebang inside the
dashboard script does not select Bash. Invoke `bash -c '...'` explicitly,
or connect using browser SSH and run the bootstrap with `sudo bash`.
After installation, reboot if /var/run/reboot-required exists, then verify
the services recover and /api/health returns 200.

Open TCP 80/443 in the Lightsail firewall. Keep port 10000 private (only bound
to host loopback). Restrict SSH to Lightsail browser SSH or the operator IP.
Attach the static IP before publishing DNS.

## DNS and HTTPS

Create an A record pointing the chosen hostname to the attached static IPv4.
Do not add an AAAA record unless IPv6 routing/firewall is also configured.
In deploy/lightsail/.env write `SITE_ADDRESS=your.actual.hostname` and run
`sudo docker compose up -d caddy` from that directory. Caddy will acquire and
renew TLS certificates; keep TCP 80 and 443 open. The default :80 address
allows initial HTTP checks before DNS is ready. Domain registration is a
separate, unapproved cost; cosmiccodex.com is a requested name, not owned yet.

## Deployed instance (2026-11-17)

- Instance: spherexview-pilot, us-west-2a, Ubuntu 24.04.
- Static IP: 52.11.76.174 (resource spherexview-public-ip).
- Temporary HTTPS: https://spherexview.52-11-76-174.sslip.io
- Initial application image built from commit ed76a5b0f3a0e3bf2830efd40d27deec928ef7ee.
- Firewall: HTTP 80; HTTPS 443 IPv4; SSH only through Lightsail browser SSH.
- Caddy certificates persist under /srv/spherexview/caddy-data.
- No snapshots, CDN, load balancer, extra disk or domain were purchased.
- cosmiccodex.com is already registered according to Verisign RDAP; choose
  another domain or arrange an ownership transfer before configuring it.
- sslip.io is a third-party DNS service, suitable as a temporary address.

Validation: Linux Docker build succeeded; all five frontend pages and health
returned HTTPS 200. A live 120-arcsec preview comparison at ICRS
(133.7599588, -7.2449993), capped to one exposure per detector per epoch,
accepted 18/18 exposures and produced three complete six-detector epochs
with aperture spectra. A simultaneous heavy request correctly returned 429.
Peak app cgroup memory was 567,693,312 bytes (about 541 MiB), with zero OOM
events; this small test is not a worst-case load benchmark. After Ubuntu
updates and a full instance reboot, HTTPS and saved results recovered.
Downloaded epoch FITS (80 HDUs) and spectrum FITS (17 HDUs) passed Astropy
verification. Local evidence is in .validation/lightsail (not committed).

## Operations

From /opt/spherexview/deploy/lightsail:

```
sudo docker compose ps
sudo docker compose logs --tail=100 app caddy
sudo docker stats --no-stream
df -h /srv/spherexview/data
curl --fail http://127.0.0.1:10000/api/health
```

Review disk usage and Lightsail CPU burst balance during the pilot. New work
is refused below 3 GiB free, but active downloads can consume additional disk.
Cache/results are not automatically deleted. No paid snapshot backup has
been enabled; copy needed results elsewhere before replacing the instance.
Jobs running during restart are lost. Results have unguessable bearer IDs,
not per-user authorization; deploy only public science data.

For updates, fetch and check out a reviewed commit, build first, then use
`sudo docker compose up -d --wait`. Check /api/health and a small science job.
Schedule updates when no computation is running. Docker restart policies
restart containers after reboot; an unhealthy status alone does not restart
a running container. Ubuntu security updates are installed unattended;
schedule required reboots explicitly.
