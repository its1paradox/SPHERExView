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
| `GET /api/coadd` | Per-detector CO-ADD stacks (deep, mixed-wavelength images; configurable `background=zodi\|none`, `sigma`, `maxiters`, `pixscale_arcsec`, and `resampling=nearest\|bilinear`) |
| `GET /api/epoch-coadds` | Time-resolved COLOR epoch-coadd blink sequence: exposures are clustered into natural sky-pass VISITS (a new epoch starts where the gap between consecutive exposures exceeds `min(30 d, bin_months·30.4375/4)` — the unWISE gap rule of Meisner et al. 2018 scaled to SPHEREx), so a visit is never split by a calendar boundary; continuous polar coverage falls back to balanced `bin_months`-long windows. Each epoch is stacked into two configurable channels on ONE shared grid, per-epoch robust z-scored. Defaults are D1–D4 (blue) + D5–D6 (orange); `short_detectors` and `long_detectors` accept any non-empty, disjoint detector groups. `pixscale_arcsec` and `resampling=nearest\|bilinear` control output sampling. When more exposures exist than `limit`, they are subsampled evenly across time. Optional `band=SPHEREx-D1..D6` focuses the blink on one detector while keeping WiseView-style color: the focus detector against a reference channel (`ref=auto` → the W-analogue counterpart, D4↔D6; `ref=excess` → same pairing, rendered client-side as a grayscale field + focus-band excess overlay; `ref=broad` → the full complementary side; `ref=none` → explicit grayscale slice) |
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

- **Epoch blink — time-resolved COLOR coadds** (`blink.html`, button next to the
  spectrum button): the SPHEREx analogue of what WiseView actually blinks.
  WiseView blinks unWISE *time-resolved coadds* — one W1/W2 stack per
  6-month WISE sky pass (Meisner et al. 2018) — not raw exposures. SPHEREx
  likewise revisits every position in short visits (days–weeks) roughly
  every 6 months, so this page clusters all exposures at a position into
  natural sky-pass visits — a new epoch starts where consecutive exposures
  are more than ~30 days apart, exactly the unWISE gap rule scaled to
  SPHEREx, so a visit is never fragmented by an arbitrary calendar
  boundary (continuous deep-field coverage falls back to balanced
  1/2/3/6/12-month windows). Each epoch is stacked into a two-channel
  color coadd (blue = D1–D4 < 3.82 µm, orange = D5–D6 > 3.82 µm) on one
  shared north-up grid, and blinks chronologically at coadd depth with one
  frozen display scale shared by all epochs, so the blink is
  photometrically and astrometrically rigid: movers drift, variables
  pulse, artifacts vanish, static sky stays pinned. Validated
  end-to-end: Barnard's star's saturation-masked core moves −0.99 px north
  between the two archived passes vs −0.97 px predicted by the Gaia DR3
  ephemeris; the NEP deep field resolves into 15 consecutive monthly color
  epochs. Dedicated window with its own playback/display controls, hover
  RA/Dec, pins with one-click spectra, per-epoch provenance panel, and
  shareable URL hash.

- **Band-focused epoch blinks stay two-color**: a *Detector band* select on
  the blink page focuses every epoch coadd on one detector (D1…D6) — but
  keeps the WiseView W1/W2 color paradigm: the focus detector is rendered
  against a *reference channel* so cold objects are distinguished by COLOR,
  not just presence. D6 focus pairs with a D4 reference — the detector-level
  W2/W1 analogue (D4 spans 2.42–3.82 µm and contains W1's 3.4 µm bandpass
  on the 3.3 µm CH4 fundamental; D6 spans 4.42–5.00 µm, the 4.6–5 µm
  opacity window where W1−W2 > 5 objects like WISE 0855−0714 emit) — so a
  very cold source glows orange against white/blue field stars. A
  *Reference channel* select offers the broad complementary side (D1–D4),
  an **excess finder** (`ref=excess`: grayscale reference field, with a
  single-hue overlay only where the focus band is in ≥2.5σ excess over the
  reference — reference-channel noise can never paint color), or an honest
  grayscale slice (`ref=none`). Travels in the URL hash as
  `band=SPHEREx-Dn&ref=auto|excess|broad|none`.

- **Scientifically correct color rendering (hue-preserving Lupton
  composite)**: two-channel frames are rendered with the Lupton, Blanton &
  Hogg (2004) algorithm — ONE asinh stretch is computed on the calibrated
  total intensity and both channels are scaled by the same factor, so hue
  encodes only the physical long/short flux ratio and never the display
  stretch ([Lupton et al. 2004](https://arxiv.org/abs/astro-ph/0312483),
  the algorithm behind SDSS and Legacy Survey color images). Channel gains
  are AB-flat (each channel in calibrated MJy/sr, restored from the
  per-epoch z-scores via the archived sky sigmas), the color language is
  wavelength-anchored everywhere in the app — the shorter band is ALWAYS
  blue, the longer ALWAYS orange (`(1, 0.5, 0)` for a long-only source and
  `(0, 0.5, 1)` for a short-only one, exactly WiseView's W1/W2 hues) — and
  a **chroma gate** desaturates pixels below 2σ joint significance toward
  neutral gray (full color from 5σ), so blank sky can never mottle into
  false pastel colors the way independently noise-normalized channels do.
  The intensity distribution is pooled once per blink sequence and shared
  by every epoch (so blinking changes are real), while the **black/white
  point sliders and stretch apply to color frames live** — the white point
  is the chosen percentile of the pooled positive intensity (floored at
  25σ) and the black point subtracts an intensity pedestal before the
  stretch, both recomputed instantly on every draw. **Invert is
  hue-preserving**: inverted pixels are complemented *and* the R/B channels
  swapped, so the sky turns white while an orange (long-λ-only) source
  stays orange and a blue one stays blue — a plain RGB complement would
  flip orange to blue and destroy the wavelength-anchored color language.
  A lone band is shown as an explicitly labeled grayscale slice, never
  silently tinted — so the same color always means the same physics in
  every stack, including the WISE→SPHEREx handoff. Switching the reference
  channel between the paired modes re-renders instantly from the already
  fetched data; switching to/from broadband or none rebuilds automatically.

- **No spurious grayscale epochs in focused movies**: SPHEREx's six
  detectors are separate strips of the focal plane (unlike WISE, whose
  W1/W2 observed simultaneously through a beamsplitter), so a sky-pass
  visit can cover a position with the focus detector but not its reference
  detector — or vice versa. In a focused movie (e.g. D6 + D4 reference), a
  visit with no focus-band exposures is dropped (it says nothing about the
  focus band at that time and would otherwise appear as a mislabeled
  grayscale of the other detector), and a visit missing only the reference
  gets a **full-depth reference** — one deep stack of all reference
  exposures in the queried span, the unWISE/Legacy-Surveys
  time-resolved-vs-full-depth paradigm — labeled explicitly (e.g.
  “+90-exp full-depth D4 ref”, `ref_scope="full-depth"` in the metadata).
  The epoch information always lives in the focus channel; the reference
  is a static comparison field, so color stays continuous across the blink.

- **Four SPHEREx timeline products**: “SPHEREx frames after WISE” offers raw
  exposures, a true D6-only grayscale slice, a **D4 + D6 W1+W2-matched**
  coadd, and a fully configurable maximum-depth color coadd. The matched
  option uses the exact same blue/orange channel placement and
  brightness/contrast controls as the preceding WiseView W1+W2 frames:
  D6 (4.42–5.00 µm) is the closest SPHEREx W2 analogue and D4
  (2.42–3.82 µm) contains the W1 wavelength. The SPHEREx spectral responses
  are not identical to the WISE filters, so labels retain D4/D6 rather than
  implying photometric equivalence. The configurable product defaults to
  the deeper D1–D4 blue + D5–D6 orange grouping, and lets the observer set
  either channel's detectors, epoch span, exposure cap, minimum channel
  depth, background treatment, clipping, output pixel scale, and
  interpolation. A 3.1″ output grid with bilinear interpolation reduces
  visible blockiness for inspection without claiming new angular
  resolution; 6.2″ nearest-neighbour remains available as the conservative
  native-sampling recipe. Every setting is encoded in the shareable URL.

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
  The stack's last frame is a **COLOR CO-ADD** in WiseView's W1+W2
  blue/orange convention: short-λ detector coadds (D1–D4, 0.75–3.8 µm)
  feed the blue channel and long-λ ones (D5–D6, 3.8–5.0 µm) the orange
  channel, each channel median/MAD z-scored so both share one sky-noise
  display scale. A source visible ONLY in orange emits only beyond
  ~3.8 µm — the signature of an extremely cold object (late-T/Y dwarfs
  such as WISE 0855−0714, which is bright at 4.5 µm yet invisible
  bluewards), exactly like an orange W2-only mover in WiseView.
- **Shared pin on every tile**: click any panel — SPHEREx epochs, WISE
  epochs, detector coadds, or the combined timeline — and one sky-anchored
  pin marks that exact RA/Dec on ALL panels through each frame's own WCS
  (copy coordinates or extract a spectrum from the pin bar).
- **Combined WISE → SPHEREx timeline**: a third panel plays every unWISE epoch
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
