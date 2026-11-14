# SPHEREx DR1 + QR3 support

Scientific contract checked against the **DR1 Explanatory Supplement v2.1
(November 10, 2026)** and the **November 12 release documentation**. This
change supports individual spectral images in the timeline, blink, static
coadds, six-detector comparison and the official IRSA spectrophotometry service.

## Release coverage and discovery

IRSA explicitly recommends DR1 and QR3 as one uniformly processed data set.
DR1 reprocesses surveys 1–2; QR3 supplies surveys 3–4 as observations become
available. Together they supersede QR2. QR2 is no longer searchable, although
IRSA plans to retain direct file downloads through February 2027.

| Selection | Wide collection | Deep collection | Calibration family | Image DOI |
| --- | --- | --- | --- | --- |
| DR1 | `spherex_dr1` | `spherex_dr1_deep` | R7 | `10.26131/IRSA678` |
| QR3 | `spherex_qr3` | `spherex_qr3_deep` | R7 | `10.26131/IRSA662` |
| QR2 (historical results only) | Retired | Retired | QR2/R6 | `10.26131/IRSA652` |

The default `release=all` queries DR1 and QR3. Each response must have the
requested collection and an HTTPS IRSA Level 2 image URL. Failed or truncated
queries remain errors; they cannot be mistaken for empty coverage. Queries
are fresh, with time-spanning preview selection performed after discovery.

Exposure identity is observation ID plus detector. Current processing takes
priority over legacy QR2, then the product version and processing date decide
between copies. DR1 and QR3 have equal priority within R7. Both `l2b-v...` and
the real archive's `l2b_retry-v...` astrometry-retry paths are supported.
Equally ranked conflicting URLs fail explicitly; a retry filename alone is
not evidence of good astrometry. Superseded URLs remain in input provenance.

Old QR2 image-query bookmarks return HTTP 410 with a DR1 + QR3 migration
message. They are not silently remapped or presented as empty coverage. A
QR2 comparison request is rejected before a background job is created.
Existing completed comparison results and spectrum job links remain readable.

## Scientific processing

Release identity and calibration compatibility are separate concepts:

- **Identity** comes from the archive collection and product path. R7 `VERSION`
  alone cannot distinguish DR1 from QR3. Both can contain version 7.0.5.
- **Compatibility** follows the documented shared R7 processing. DR1 and QR3
  may contribute to one detector coadd or one temporal visit/window. QR2
  remains separate and cannot bridge or fragment an R7 visit.
- **Version gate:** the published pipeline table covers R7.0–7.2. The loader
  accepts this range with explicit archive release provenance, and rejects
  later, unreviewed versions. Historical R6.4+ QR2 checks are retained.

The linear estimators, mask semantics and variance propagation are unchanged.
No extra gain correction is applied. Negative calibrated values remain data.
`IMAGE` and `ZODI` use MJy/sr, and `VARIANCE` uses (MJy/sr)² with declared unit
conversion. The supplied zodiacal model is subtracted only when the recipe
requests it; individual spectral images have not already had it removed.
The coadd science paths reject non-finite values, nonpositive variances,
defined fatal/artifact flags and nonzero or missing `FINAST`. Raw exposure
previews remain inspection images. R7 flag names/values are read from
the file rather than inferred from dates or detector numbers. `SOURCE` and
`FULLSAMPLE` alone are not rejected. `MJD-AVG` and `TIMESYS` determine the UTC
midpoint, checked against the archive within one second.

Both releases use `cal-swcs-v5-2026-191` as the validated spectral-calibration
pin when HISTORY supplies calibration UUIDs rather than a versioned path.
An explicit versioned HISTORY path takes precedence. The six-detector science
path loads full-resolution `CWAVE` and `CBAND`, validates the detector,
sky orientation, active-pixel WCS and spectral WCS agreement, and records the
file hash. An absent or mismatched calibration excludes that input; there is
no fallback to approximate science wavelengths. The timeline's target
wavelength remains an explicitly labeled approximate WCS-WAVE display lookup.

R7 requires an `EPSF` binary table. The code does not assume every detector
has 441 PSF zones: the tested D3 table has 451 (11 × 41), while the other
detectors have 441 (21 × 21), with 33 × 33 samples per PSF. Native PSFs remain
unmatched; this viewer does not implement its own forced PSF photometry.

Epoch metadata contains `data_releases`, `calibration_family`, release DOIs
and each contributing input's original identity, pipeline and calibration
provenance. A joint label is `dr1+qr3`. Channels rejected by the exposure
floor do not appear as contributors to a displayed color/grayscale frame.
Six-detector metadata distinguishes the inventory's releases from accepted
inputs. FITS exports include `RELEASE`, `CALFAM`, `GAINCONV=F`, WCS, all
scientific maps and the full input manifest. The algorithm identifier is
`six-detector-1.2-dr1`.

## Spectra

Photometry remains with IRSA. DR1/QR3/legacy QR2 filtering uses the returned
`data_collection`, including the wide/deep collection aliases. Unknown
provenance stays visible under **All returned releases**. The selector filters
results rather than restricting the remote job. CSV and JSON follow the
release selection; the original VOTable contains the complete job result.

Fluxes, errors, wavelengths and quality flags are preserved. The DR1 supplement
states that the service's reported flux errors include a 3% flux term in
quadrature; SPHERExView does not add it again. Image statistical variance has
a different scope and is not assigned this term automatically. JavaScript
BigInt preserves photometry quality bits above bit 31.

Lines/Connected mode draws independent wavelength-ordered traces by release,
with singleton markers when a filter leaves only one point. Shared calibration
does not turn distinct exposures into a single simultaneous spectrum: no
measurements are averaged or invented by the connecting lines.

## Validation

Run the deterministic backend and frontend regression suites:

```bash
python -m pip install -r backend/requirements.txt pytest httpx
python -m pytest -q backend/tests
cd frontend
npm ci
npm test
npm run build
```

Coverage includes release identity, active/retired discovery, duplicate and
retry products, calibration incompatibility, native signed flux and variance,
interleaved and equal timestamps, channel floors, genuine time gaps, window
edges, comparison FITS, high-bit flags, bookmarks and actual React canvas
commands for mixed-release spectra. Historical QR2/QR3 separation regressions
are retained with offline fixtures.

The [live validation record](validation/dr1-2026-11-14.json) records real
DR1 and QR3 cutouts from all six detectors, full-resolution calibration hashes,
PSF table shapes, native values, timestamps, masks and FITS map/checksum
round trips. The reproducible script also reads completed IRSA spectrum jobs:

The November 14 check passed **80 backend tests and 42 frontend tests**, plus
the production frontend build. Live discovery returned **330 DR1 + 113 QR3**
unique observation/detector pairs at the recorded position; bounded deep
queries returned **54 DR1-deep and 47 QR3-deep** rows. All twelve image samples
passed, and the full-resolution calibration files had matching SHA-256 hashes
between DR1 and QR3 for every detector. Two newly submitted photometry jobs
returned **six DR1 and eight QR3** measurements. All four image routes and
spectrum JSON/CSV/VOTable routes passed live API checks.

```bash
python scripts/validate_dr1.py --output dr1-validation.json
# Optional; jobs are available only while IRSA retains them:
python scripts/validate_dr1.py --output dr1-validation.json \
  --api-smoke \
  --spectrum-job 83e8a906-58a9-481d-880b-da6766e437e8 \
  --spectrum-job b728e4e4-282a-4ff7-bebd-9bd8b3234833
```

The first run downloads approximately 400 MB of cached spectral calibrations,
plus small image cutouts. Assertions fail rather than declaring incomplete
validation successful. These are integration and numerical regression checks,
not an independent absolute-photometry calibration or a survey-wide audit.
Bounded deep-field queries test both deep collection identities. `--api-smoke`
also exercises the real image and spectrum API routes against IRSA, including
retired QR2 responses and unchanged original VOTable bytes.
IRSA returned intermittent HTTP 503 responses during validation; bounded
retries and explicit skipped-input handling were exercised. Final image-file
checks completed using the downloaded cache. Browser visual inspection was
unavailable because the browser could not reach the workspace app; the UI was
tested through React/DOM/canvas integration tests, build and static-route checks.

Detector coadds combine variable LVF wavelengths and native PSFs; they are
neither monochromatic measurements nor WISE-equivalent bandpasses. Formal
image variance excludes calibration systematics, zodiacal-model uncertainty
and input/resampled pixel covariance. Inspect the coverage and wavelength/time
maps before interpreting apparent variability.

## All-sky cube scope

The DR1 all-sky cube is a separate product and is not ingested as a Level 2
exposure. It uses 12.9-arcsecond HPX pixels and 102 nominal channels (channels
51–52 are blank), collapses the time information, has zodiacal light already
subtracted, and provides NHITS/FLAGS without the image VARIANCE extension.
It needs a separate reader, WCS/coverage handling and uncertainty presentation.
Cube URLs are deliberately rejected by this image-processing contract.

## Primary sources

- [IRSA releases, November 12, 2026](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-releases/)
- [DR1 overview and image/cube DOIs](https://irsa.ipac.caltech.edu/data/SPHEREx/docs/overview_dr1.html)
- [DR1 Explanatory Supplement](https://irsa.ipac.caltech.edu/data/SPHEREx/docs/SPHEREx_Expsupp.pdf),
  v2.1, November 10, 2026: pipeline-version table; fine astrometry and retry;
  image, mask, spectral calibration, EPSF and photometry specifications.
- [Official data products](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/)
- [Official data access](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-access/)
- [Spectral-image and calibration tutorial](https://caltech-ipac.github.io/irsa-tutorials/spherex-intro/)
- [Official PSF tutorial](https://caltech-ipac.github.io/irsa-tutorials/spherex-psf/)
- [IRSA spectrophotometry tool](https://irsa.ipac.caltech.edu/onlinehelp/spherex/spherex/sp.html)
