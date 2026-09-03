# SPHERExView

A [Wiseview](http://byw.tools/wiseview)-style blink viewer for **SPHEREx** spectral images.
Enter RA/Dec, fetch time-ordered cutouts from NASA/IPAC IRSA, and blink/scrub
through epochs to spot movers and variables — the citizen-science workflow
Wiseview popularized for WISE, applied to SPHEREx. Includes one-click
**forced-photometry spectra** for any position via IRSA's SPHEREx
spectrophotometry service, and **shareable URLs** that capture the complete
view state.


## Architecture

```
frontend/  React + Vite         
backend/   FastAPI (Python 3.11+)
```

Data flow: browser → `/api/epoch-stack` (SPHEREx via IRSA SIA2) and
`/api/wise-stack` (time-resolved unWISE epochs via [WiseView](http://byw.tools)'s
services) → FITS cache → **raw float32 pixel arrays** (base64) → client-side
stretch/contrast/zoom rendering on canvas. 

## Quick start (one click)

The only requirement is **Python 3.10+** ([python.org](https://www.python.org/downloads/)
— on Windows, tick "Add python.exe to PATH" in the installer). No Node.js
needed: the repo ships a pre-built frontend that the Python server serves
directly.

- **Windows**: double-click **`run.bat`**
- **macOS / Linux**: `./run.sh`

The first launch creates a private Python environment in `.venv/` and
installs the dependencies (a minute or two); every launch after that is
instant. Your browser opens at http://localhost:8000 automatically.
Close the window (or Ctrl+C) to stop the app.

## Development setup

For hacking on the code, run the two dev servers with hot reload
(requires Node.js 18+):

Backend:

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Frontend (separate terminal):

```bash
cd frontend
npm install
npm run dev
```
Open http://localhost:5173

After frontend changes, refresh the shipped build with `npm run build`
(in `frontend/`) so the one-click launchers pick them up.

## Hosting as a web app

The single-server mode used by the launchers is deployment-ready: the
FastAPI app serves both the API and the built frontend, so any host that
runs a Python web process works (Render, Fly.io, a VPS, …):

```bash
pip install -r backend/requirements.txt
uvicorn backend.app.main:app --host 0.0.0.0 --port $PORT
```

FITS downloads are cached under `backend/cache/`, so a persistent disk
(or volume) makes repeat targets fast for all visitors.


## API

| Endpoint | Description |
|---|---|
| `GET /api/health` | Liveness check |
| `GET /api/cutouts` | Cutouts around a position |
| `GET /api/epoch-stack` | Time-ordered cutout stack for blinking |
| `GET /api/coadd` | Per-detector CO-ADD stacks (deep, mixed-wavelength images; `background=zodi\|none`, `sigma`, `maxiters`) |
| `GET /api/wise-stack` | Time-resolved unWISE epoch stack via WiseView (byw.tools), one dated frame per ~6-month visit, optional Gaia DR3 markers |
| `POST /api/spectra/submit` | Submit an IRSA SPHEREx spectrophotometry job (`ra`, `dec`, `bkg_region`) |
| `GET /api/spectra/status/{job_id}` | UWS job phase (QUEUED / EXECUTING / COMPLETED / ERROR) |
| `GET /api/spectra/table/{job_id}` | Flattened per-exposure spectrum as JSON (columns, units, rows) |
| `GET /api/spectra/download/{job_id}?fmt=votable\|csv\|json` | Download the spectrum (original IRSA VOTable, or flattened CSV/JSON) |

Query params: `ra`, `dec` (deg), `radius_arcsec` (default 60), `survey`
(`wide` → `spherex_qr2`, `deep` → `spherex_qr2_deep`), `band` (optional
substring filter, e.g. `SPHEREx-D1`), `limit` (max frames — no upper cap;
hundreds of frames just take proportionally longer to download the first
time, cutouts are cached on disk afterwards).

Response cutouts include `data_b64` (raw little-endian float32 pixels,
display-oriented: row 0 = top), `width`/`height`, `fits_url` (original cutout
for download), and metadata (band, MJD, UTC datetime, exposure time,
wavelength range).

`/api/wise-stack` params: `ra`, `dec`, `size_arcsec` (field of view, default
120), `band` (`w1`|`w2`), `gaia` (bool). Epochs are discovered via
`byw.tools/tiles?ra=&dec=` and fetched via
`byw.tools/cutout?ra=&dec=&size=&band=&epoch=` Each frame carries its real mean observation date
(`mjd`, `datetime_utc` from the tile catalog's MJDMEAN), so blinking shows
true ~2010→present proper motion. With `gaia=true` each frame carries Gaia
DR3 markers in image-pixel coordinates, proper-motion propagated from epoch
2016.0 to each frame's mean epoch and projected through the cutout's own WCS.


## Features

- **Shareable URLs**: every query and display attribute — target, FoV,
  survey, bands, WISE band, zoom, blink speed, stretch, black/white points,
  invert, smoothing, Gaia markers, outer-epochs mode, … — lives in the URL
  hash (e.g. `#ra=133.786&dec=-7.245&size=240&zoom=450&sxstretch=sqrt`).
  Opening a link with `ra`/`dec` restores the exact view and fetches it
  automatically, WiseView-style.
- **Spectra on demand**: a *Generate spectrum* button (for the search target,
  or for a dropped pin at an exact source position) submits an IRSA
  spectrophotometry job and opens a spectrum tab: all-band scatter plot
  (wavelength vs. flux with error bars, D1–D6 color-coded, hover for
  per-point λ/flux/MJD/flags, log/linear flux, flagged-point filtering,
  and the same trace styles as IRSA's chart — points, connected points,
  or lines), a full data-table view, and downloads as VOTable/CSV/JSON/PNG. Jobs run
  on IRSA and take minutes; the tab URL carries the job id, so reloading
  (or sharing the link) reattaches without resubmitting.

- **Per-detector CO-ADD (mixed λ)**: a dedicated panel stacks every
  exposure of each detector (D1–D6) into one deep image and blinks the six
  results in wavelength order. Scientifically careful recipe: the QR2
  pipeline's own zodiacal-light model (`ZODI` extension) is subtracted from
  every exposure first (zodi is seasonal — unsubtracted stacks would mix
  date-dependent backgrounds), pixels with fatal `FLAGS` bits or invalid
  `VARIANCE` are zero-weighted, everything is resampled ONCE
  (nearest-neighbour, no second interpolation) onto one shared north-up
  grid, optionally sigma-clipped (5σ about the median, MAD scale, only when
  N ≥ 5), and combined with a weighted mean using per-exposure inverse SKY-variance
  weights (signal-independent, so source photometry is unbiased — per-pixel
  1/V weights would down-weight exposures where the source is brightest and
  depress its flux) — so SNR
  grows ∝ √N for stationary sources. Because each SPHEREx detector sits
  behind a linear variable filter, a detector coadd averages a range of
  wavelengths: the label and frame info report the ACTUAL λ min / weighted
  mean / max sampled at the target (evaluated per exposure from the
  official `WCS-WAVE` lookup table), plus exposure count, MJD span,
  per-pixel coverage and full provenance (`obs_id` list). Faint sources
  invisible in single 100s exposures pop out; note that coadding averages
  away variability and proper motion — use the epoch blink for those.
- **Combined WISE → SPHEREx movie**: a third panel plays every unWISE epoch
  (2010→present) followed by every SPHEREx exposure as ONE chronological
  sequence in a shared sky frame — exactly the query FoV, north up, east
  left, at a fixed arcsec-per-screen-pixel scale, with each frame placed by
  an affine transform derived from its own WCS (east/north basis vectors
  evaluated at the target through the exact TAN projection). A high
  proper-motion source such as Barnard's star moves in one continuous
  direction across the mission handoff. Mission tag, band, date, scale bar
  and N/E compass are drawn on every frame.
- SPHEREx epoch blinking with multi-band filtering (D1–D6 checkboxes —
  pick any combination; none checked = all) and per-frame UTC observation
  datetime.
- **Synced crosshair**: hover anywhere on either panel and a crosshair
  tracks the exact same sky position on the other panel in real time
  (world→pixel through each frame's own WCS).
- **Frame info**: pause the SPHEREx panel and a *Frame info* button reveals
  every piece of archive metadata IRSA holds for that exposure (~50 fields:
  obs_id, exposure time, wavelength coverage, calibration level, data
  product type/subtype, …) plus direct FITS download links for the cutout
  and the full exposure.
- Side-by-side WISE panel with **time-resolved unWISE epochs from WiseView**
  (one dated frame per ~6-month visit, 2010→present) — W1, W2 or the
  AstroToolBox-style **W1+W2 color composite** (W1→red, W2→blue,
  green = average, shared limits), where very red objects like Y dwarfs
  glow orange. Toggle on/off.
- **Real-time RA/Dec hover readout** under each panel: move the cursor over
  either image and the sky coordinates under it update live, per frame, via
  each frame's own WCS.


## Alignment & WCS

SPHEREx cutouts are reprojected (`reproject`, nearest-neighbour — raw pixel
values survive) onto a plain TAN grid centered on the requested position at
the frame's native pixel scale, north up, east left — the same orientation
as unWISE/WiseView cutouts. The backend requests a ~45% margin around the
field so rotated exposures still fill the display FoV. Each frame ships its
linear TAN WCS to the frontend, which does the gnomonic deprojection for
the hover readout in JS (validated against astropy to ~1e-10 arcsec).
Cross-panel alignment is validated in CI-style tests: a bright Gaia star
lands on the same sky position in every SPHEREx frame to sub-pixel accuracy
regardless of spacecraft roll.


## Data sources

- SPHEREx QR2 spectral images via [IRSA SIA2](https://irsa.ipac.caltech.edu/docs/program_interface/sia.html)
  (`spherex_qr2`, `spherex_qr2_deep`)
- Cutouts via IRSA's dataset-level cutout service (`?center=&size=` on the image `access_url`)
- WISE images: time-resolved unWISE epoch coadds via
  [WiseView](http://byw.tools/wiseview) (`byw.tools/tiles`, `byw.tools/cutout`,
  2.75″/px) — thanks to Dan Caselden's WiseView and Frank Kiwy's
  [AstroToolBox](https://github.com/fkiwy/AstroToolBox) for the interaction model
- Star markers: [Gaia DR3](https://gea.esac.esa.int/archive/) via astroquery TAP
