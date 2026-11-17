# SPHERExView

SPHERExView lets you explore WISE and SPHEREx images of the same patch of
sky. Browse observations by date, blink between epochs, compare the six
SPHEREx detectors, and request a spectrum at a selected position.

The app runs locally in your browser. It retrieves SPHEREx DR1 and QR3 images and
spectra from NASA/IPAC IRSA, and time-resolved unWISE images through WiseView.

## Run the app

You need **Python 3.10 or newer** and an internet connection. On Windows,
enable **Add Python to PATH** when installing Python.

1. Download this repository using **Code → Download ZIP**, then extract it.
2. Start the launcher:
   - **Windows:** double-click `run.bat`.
   - **macOS / Linux:** open a terminal in the extracted folder and run
     `bash run.sh`.
3. Your browser opens at [localhost:8000](http://localhost:8000).

The launcher creates a Python environment and installs the required packages.
The frontend is included, so Node.js is not needed to run the app. Keep the
terminal open while using it; press **Ctrl+C** to stop the server.

The first query can take several minutes, depending on the field size and
number of exposures. Downloaded files are cached in `backend/cache/` for
reuse. If port 8000 is already in use, set the `PORT` environment variable
before starting the launcher.

Transient SPHEREx download failures are retried with increasing delays and
respect for the archive's requested wait time. See
[archive download recovery](docs/ARCHIVE_DOWNLOADS.md) for retry limits and validation.

## Using SPHERExView

The landing page is your **research library**. Enter a sky position and field
width, then choose **WISE–SPHEREx** or **6 detectors**. Searches from either
tool are retained automatically, with one entry per exact coordinates, field
width, survey and release selection. Each tool remembers its own recipe and
display settings. The library link in either viewer returns to this dashboard.

History and results live **on the user's device in IndexedDB**, not in a
per-user server archive. Each saved response includes its numerical data and
provenance. All raw timeline frame pixels and detector FITS/manifest exports
are downloaded into local storage before the snapshot is marked saved.
Revisiting an unchanged recipe reads these local files, including after the
server cache expires. This still requires loading the web application itself;
it is not a fully offline installable app.

The dashboard reports actual saved payload bytes per field (excluding browser
database overhead), split into timeline data, pixels, detector data and exports.
It never adds the sizes of the shared server cache to a user's local total.

- **Refresh data:** explicitly query the selected tool again. Every eligible
  observation remains in scope. A complete replacement is committed atomically;
  failures or device quota errors preserve the previous snapshot. Reopen normally
  to view the previous saved result; use Refresh again to retry. The weekly
  reminder does not claim that new observations are available.
- **Clear cached files:** delete local result payloads while retaining the target
  and recipes. Opening a tool rebuilds the deleted products.
- **Remove target and data:** delete the local entry and its results. Neither
  action affects files separately exported to the user's downloads folder.
- **Protect local storage:** request browser persistence. The browser may decline.
  Browser quotas still apply, and clearing site data deletes the library. Export
  important FITS/manifests for long-term retention. There is no cross-device sync.

Raw archive FITS are processed by the Python backend; processing has not moved
into the browser. They are shared by immutable URL in a bounded source cache,
not duplicated per user. The browser stores the generated research products.

### Server storage policy

Use one server process, as in the existing Docker deployment. Cache locks,
reader pins and public admission controls are process-local. Defaults:

| Setting | Default | Purpose |
| --- | --- | --- |
| `SPHEREX_SOURCE_CACHE_BYTES` | 2 GiB | Shared source FITS and calibration LRU cache |
| `SPHEREX_RESULT_CACHE_BYTES` | 1 GiB | Temporary result handoffs, globally across users |
| `SPHEREX_RESULT_TTL_SECONDS` | 3600 | Idle handoff lifetime; checked every minute |
| `SPHEREX_WORK_BYTES` | 8 GiB | Per-job temporary timeline scratch budget |
| `SPHEREX_MIN_FREE_GB` | 3 GiB | Free disk reserve |

Source-cache writes reserve space before writing each chunk. Active readers and
prefetches pin their files, so eviction cannot change an ongoing calculation.
Completed result handoffs use LRU/expiry cleanup. In-progress output staging is
protected and checked before publication; it can temporarily exceed the retained
result budget while a job is building. Public admission admits one heavy job at a
time. Scratch arrays are disk-batched and deleted when a job finishes, including
failure; abandoned scratch is removed on restart. These are storage budgets,
**not observation-count limits**. Insufficient working capacity returns an explicit
error rather than substituting a scientifically incomplete subset.

On startup, known legacy source FITS, comparison products and timeline JSON
pixels move into managed storage and become eligible for eviction. Old server-only
result links can therefore expire; the saved local recipe can rebuild them. No
server search-history API or per-user history files are created. Temporary transfers
use a random browser key in headers, never in shared URLs. Search history from
before this feature cannot be reconstructed automatically.

No new database server, storage subscription or paid service is required.

The WISE timeline is also available directly at `timeline.html`; older
`index.html#ra=…&dec=…` bookmarks continue to open the timeline.

Enter **RA and Dec in decimal degrees**, choose a field of view in arcseconds,
and click **Fetch images**. The default view combines WISE W1+W2 color epochs
with SPHEREx D4+D6 color coadds. All eligible observations are processed; there
is no frame or input-exposure cap. Individual WISE
and SPHEREx panels can be enabled from the panel controls.

Coordinates and field width remain visible above the WISE → SPHEREx timeline,
including while scrolling. The same values are available in Target & images.
Aligned inputs are processed in disk-backed batches and individual image pixels
load on demand. Observation processing details report attempted inputs and
exclusions. See [full-inventory processing and validation](docs/TIMELINE_BATCHING.md).

Choose **DR1 + QR3** (the default), **DR1** or **QR3** with the Data release
selector. DR1 covers reprocessed surveys 1–2; QR3 adds surveys 3–4 as released.
Their compatible calibrations allow joint coadds within the chosen time bins,
with each input's release retained in the provenance. The selection follows
shared links and the other viewers. QR2 searches have been retired by IRSA;
old QR2 image links show an explicit message, while saved results remain readable.
See [DR1 support and scientific validation](docs/DR1_SUPPORT.md).

- **Combined timeline:** play or scrub through both missions in date order.
  Choose raw SPHEREx exposures, D6 grayscale coadds, matched D4+D6 color
  coadds, or a custom detector combination.
- **Epoch blink:** inspect SPHEREx coadds grouped by observing visit.
- **SpherexMultiView:** compare D1–D6 at one epoch using grayscale,
  detector-to-reference color, or wavelength color, alongside a seventh RGB
  composite. Hover or pin any tile for an instant, precomputed aperture
  spectrum with wavelength/frequency axes and flux density in µJy. Expand a
  tile and use Previous/Next to move between all seven views. See the
  [measurement method and limitations](docs/LIVE_APERTURE_SPECTRA.md). Disable **Precompute aperture spectra**
  for an images-only build when exploring large fields or time ranges.
- **Spectrum:** click an image to pin a position, then request an IRSA
  forced-photometry spectrum. Spectrum jobs can take several minutes. The
  release selector filters returned measurements; it does not restrict the
  remote job. Saved QR2 measurements remain available in legacy job results.

Zoom, pan, brightness and contrast help inspect the images. The comparison
view can export PNG figures, FITS maps and processing metadata; spectra can
be downloaded as VOTable, CSV or JSON. Viewer settings are stored in the URL
so you can bookmark a field or share the same view.

Color views are inspection aids. Wavelength color shows the wavelengths
sampled by a coadd; it does not measure a source's spectrum. Different
detectors also have different sampling, coverage and point-spread functions.
Use the pixel readouts, coverage maps and spectra when interpreting a feature.

## Development

The backend uses FastAPI and the frontend uses React with Vite. Install the
Python dependencies in a virtual environment, then start the backend from
the repository root:

```bash
python -m pip install -r backend/requirements.txt
python -m uvicorn backend.app.main:app --reload --port 8000
```

In a second terminal, with a current Node.js LTS release installed:

```bash
cd frontend
npm ci
npm run dev
```

Open the URL printed by Vite. To run the frontend checks and refresh the
build used by the launchers, run these from the repository root:

```bash
cd frontend
npm test
npm run build
```

Backend tests use pytest. Run these commands from the repository root:

```bash
python -m pip install pytest httpx
python -m pytest -q backend/tests
```


## Public hosting

See [the Lightsail deployment guide](docs/LIGHTSAIL_DEPLOYMENT.md) for the
$12/month public pilot, HTTPS setup, persistent storage, resource limits and
operational checks. [The Render guide](docs/RENDER_DEPLOYMENT.md) records the
alternative deployment package and its validation.

## Data sources

- SPHEREx DR1 and QR3 spectral images via [IRSA SIA2](https://irsa.ipac.caltech.edu/docs/program_interface/sia.html)
  (`spherex_dr1`, `spherex_dr1_deep`, `spherex_qr3`, `spherex_qr3_deep`).
  This viewer uses individual spectral images; the DR1 all-sky cube requires
  a separate data path and is not included in these coadds.
- Cutouts via IRSA's dataset-level cutout service (`?center=&size=` on the image `access_url`)
- WISE images: time-resolved unWISE epoch coadds via
  [WiseView](http://byw.tools/wiseview) (`byw.tools/tiles`, `byw.tools/cutout`,
  2.75″/px) — thanks to Dan Caselden's WiseView.
- Star markers: [Gaia DR3](https://gea.esac.esa.int/archive/) via astroquery TAP
