# RGB and aperture spectra implementation

RGB and native-exposure aperture spectra on the DR1/QR3 main branch.

## Acceptance checklist

- [x] Seven detector/RGB tiles, linked navigation, stable pins and expanded views.
- [x] Native-exposure aperture Fν with calibrated solid angles and CWAVE/CBAND.
- [x] Signed flux, propagated independent-pixel variance, explicit partial coverage.
- [x] Configurable aperture, optional source-masked local annulus, wavelength/frequency axes.
- [x] DR1/QR3 input identities and separate coadd/spectrum contributor provenance.
- [x] Optional independent release guides; no interpolated samples in scientific exports.
- [x] CSV, PNG, FITS and manifest exports; older results remain readable.
- [x] Images-only builds skip aperture work and its budget entirely.
- [x] Numerical, API, DOM and mixed-release regressions; production frontend rebuilt.
- [x] Real DR1/QR3 checks on all six detectors and desktop/mobile browser smoke validation.

## Validation record

135 backend tests and 54 frontend tests pass. The production Vite build succeeds.
Headless Chrome checks the actual built page with explicitly synthetic data:
seven tiles, pinning, independent release guides, frequency mode, CSV/PNG
downloads, expanded RGB and the 390-pixel mobile layout. Display interactions
make no archive requests and no JavaScript page errors were observed.

The [real-data record](validation/rgb-aperture-dr1-2026-11-14.json) covers all
six detectors in both DR1 and QR3: twelve exposures and 1,200 usable grid
positions, unchanged native coadd samples in images-only mode, calibrated
variances and FITS/provenance round trips. Each cutout and spectral calibration
matches the SHA-256 hash pinned in the [input record](validation/rgb-aperture-inputs-2026-11-14.json).
The paired DR1/QR3 solid-angle hashes agree for all six detectors.

The retry downloaded the missing D2–D5 products, then reran the complete check
from cache. The original QR3 D4 exposure repeatedly returned HTTP 503, so its
replacement is an explicitly recorded, archive-listed 2026W23 exposure. DR1 D4
and QR3 D5 were recovered with the equivalent `180.0arcsec` size spelling;
their bytes exactly match the original recorded cutout hashes. The input record
retains these retrieval details and the replaced URL. Measurement code and
acceptance thresholds were unchanged.

Browser checks are recorded in [the browser record](validation/rgb-browser-2026-11-14.json).
The downloader's retry and cache protections are covered by the backend suite;
see [archive download recovery](ARCHIVE_DOWNLOADS.md) for the 2026-11-15 update
and a fresh download check against the original QR3 D4 exposure.
These checks do not establish absolute photometric accuracy or guarantee
survey-wide performance. Aperture precomputation adds CPU, memory and download
cost; images-only mode retains the original query and cutout sizes. With spectra
enabled, the larger discovery/padding can intentionally add edge contributors.

## Decisions

The RGB image is illustrative: equal detector-pair means with one shared
brightness stretch, requiring valid coverage in all six detectors. Scientific
arrays retain negative values and native PSFs.

Aperture measurements use each input image, not a detector coadd. Partial
measurements never recover or rescale masked flux. The optional smooth guide
is separate for each release, and does not determine a physical spectral peak.

Keep DR1 discovery, retirement of QR2 searches, and R7 calibration compatibility
from main. Preserve legacy saved results without changing their measurements.
Release labels for spectra describe spectrum contributors independently from
contributors to coadd images.

Precomputing spectra is an explicit recipe choice. Bounds fail before downloads;
users can disable spectra to retain image-only comparisons. Display controls
and hover must not submit additional archive requests.
