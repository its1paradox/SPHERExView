# Render deployment

This branch packages the validated DR1 + QR3 app and current four-page frontend
for a single Render web service. It does not contain research caches, results,
credentials, or local Python environments.

## Dashboard configuration (prepared 2026-11-17; approval pending)

| Setting | Value |
| --- | --- |
| Workspace | My Workspace, Hobby |
| Source | https://github.com/its1paradox/SPHERExView |
| Branch | codex/render-deployment |
| Name | spherexview |
| Language | Docker |
| Root directory | empty (repository root) |
| Dockerfile | ./Dockerfile |
| Build context | . |
| Region | Oregon (US West), near the US archive services |
| Compute | 1 CPU / 2 GB RAM, $25/month |
| Disk | 20 GB at /var/data, $5/month |
| Health check | /api/health |
| Docker command | empty (use Dockerfile CMD) |
| Auto-deploy | Off; release manually after validation |
| Build tier | Starter; existing additional spend limit $0 |

Baseline cost: **US$30/month before taxes**. Hobby has no fixed workspace fee.
The account shows 5 GB included outbound bandwidth and 500 build minutes/month.
Additional public outbound traffic costs $0.15/GB. The existing $0 build spend
limit prevents paid build-minute top-ups. This is not a hard cap on total bills.
No custom domain, database, Redis, or separate worker is required for this pilot.
No paid service may be created until the user approves this cost.

The account needs a payment method; the owner should enter it directly in Render.

## Runtime

The multi-stage image builds the frontend with its npm lockfile, then uses
Python 3.14.7 and the resolved scientific dependency versions from the validated
DR1 installation. Windows-only pywin32-ctypes is omitted. Linux-specific
transitive dependencies are resolved during the Render build. Official Linux
amd64 base-image tags were verified available. This machine has no Docker,
so the actual Linux image build remains a deployment-stage acceptance check.

`deploy/start.py` starts exactly one Uvicorn process and binds Render's `PORT`
on `0.0.0.0`. Do not add Uvicorn workers or another service instance: job status
and the admission semaphore are process-local. The API and frontend share one
origin. Persistent paths are `/var/data/cache`, `/var/data/static`, and
`/var/data/astro-cache`. Same-origin browser requests need no CORS allowlist.

The container enables these explicit pilot controls:

- One expensive API request or background comparison at a time. Busy requests
  get HTTP 429 with Retry-After; the browser retries up to eight times, with
  cancellation support, then shows the error. There is no server-side queue.
- Health, comparison status, cancellation, and completed comparison downloads
  remain available while work runs.
- Two internal image-download threads and one numerical-library thread.
- Image-query radius up to 120 arcsec, WISE size up to 240 arcsec, limit up to
  500, coadd pixel scale at least 3.1 arcsec.
- Comparison field up to 240 arcsec and pixel scale at least 6.2 arcsec. Existing
  science cell budgets still apply. Excess requests are rejected explicitly;
  recipes and scientific arrays are never silently reduced.
- New work pauses below 3 GiB free disk. This is admission protection, not a
  hard per-job disk quota. There is no automatic deletion/expiry in this release.

These are public-pilot limits, not a high-volume multi-user queue. There is no
account-based result ownership, per-user rate quota, or automatic cache cleanup.
Comparison IDs are unguessable bearer links; anyone with a link can access the
result and cancel its active job. Do not use this deployment for private inputs.
The disk needs periodic usage review. Results are not a permanent archive:
users should download their FITS/CSV exports. Jobs interrupted by a restart do
not resume; completed result files survive via the disk.

## Deployment acceptance after cost approval

1. Owner adds a payment method directly in Render Billing.
2. Confirm this branch, 1 CPU / 2 GB, the 20 GB mount, health path, and manual
   deploy setting on the dashboard; deploy once.
3. Follow build and runtime logs. Require health check passing and no boot loop.
4. Verify HTTPS root, compare, blink, spectrum and movie pages; check API health.
5. Run a small DR1/QR3 archive request, then a representative comparison.
6. Verify result JSON, manifest, FITS and spectra downloads; cancellation and
   busy-request behavior; inspect actual Render RAM, CPU, disk and latency.
7. Restart only after jobs finish, and verify completed results persist.
8. Keep the 2 GB tier only if observed memory has adequate headroom. A 4 GB tier
   costs $85/month compute ($90/month with this disk), and requires separate
   user approval before upgrading. Do not enable autoscaling or paid add-ons.

A disk prevents zero-downtime deployments and multiple instances; expect a
brief interruption during releases. Schedule releases while idle.

## Validation

Frontend: 67 tests passed and production build passed. All six local health/page
smoke checks returned HTTP 200. Backend scientific and deployment-admission
regressions are run using the validated DR1 scientific package versions.
Backend: 142 tests passed (135 existing regressions plus 7 admission tests).

A read-only cached reference replay selected 268 exposures, accepted 260, and
produced three epochs. It used 238.7 MiB peak process RSS and completed in
230.17 seconds on the Windows development machine with two fetch threads.
All 18 detector-map dictionaries and all three exposure-spectrum collections
matched the saved reference exactly. This is not a Linux/Render load benchmark:
archive transfer time, concurrent downloads, kernel caches and different input
fields still need live verification. The 2 GB tier is a measured pilot choice,
not a guarantee of unrestricted production workloads.

## Sources

- https://render.com/docs/docker
- https://render.com/docs/disks
- https://render.com/docs/outbound-bandwidth
- https://render.com/docs/build-pipeline
- The signed-in service-creation and workspace billing dashboards, 2026-11-17.
