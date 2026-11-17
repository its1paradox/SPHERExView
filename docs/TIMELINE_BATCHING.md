# Full-inventory timeline processing

The WISE → SPHEREx timeline processes every discovered observation matching
the selected release, field and detector channels. There is no application
frame-count or input-exposure cap. Legacy API `limit` parameters and bookmark
`maxframes`/`climit` settings no longer truncate results. The six-detector
explorer's independently labelled preview recipes are unchanged.

## Calculation and storage

Downloads and reprojections run in batches bounded by `SPHEREX_FETCH_WORKERS`
(two on the public instance). Aligned science, variance and validity arrays
are appended to three scratch files under `SPHEREX_CACHE_DIR/timeline-work`.
They are removed on normal completion and exceptions.

Coadds operate on spatial tiles with a 32 MiB temporary-array budget
(`SPHEREX_COADD_TILE_BYTES`). Every pixel's sigma clipping sees **all** input
exposures together. After clipping, each exposure's scalar weight is computed
from its full surviving variance map. The final weighted mean, propagated
variance, coverage, rejected-pixel count and central-aperture wavelength
summary use the same estimator as the original full-array implementation.
Batch means or separately clipped batch results are never combined.

Raw-frame responses contain metadata and `data_url` links instead of embedding
all pixel arrays. Content-addressed JSON files in the persistent static cache
avoid duplicate storage on repeated requests. The browser loads the current
and reference frames and retains a 12-frame pixel cache, pinning frames that
are currently displayed. Playback waits for missing pixels; failed downloads
are displayed as errors rather than skipped silently. The frame slider still
addresses the entire timeline. Small WISE and epoch-coadd output sequences
continue to use their existing payloads and display calculations.

## Completeness and operational limits

Processing details expose attempted, available/contributing and skipped counts,
plus observation IDs and reasons for unavailable inputs. No-overlap, quality
masks, missing time/detector metadata and configured channel thresholds still
apply. The combined raw timeline continues to omit frames without target
coverage and reports that count; those frames remain in the individual panel.
An archive inventory overflow remains an explicit error, never a sampled
success. A successful calculation does not imply every archive download was
available: consult the omissions.

The public server retains one-heavy-request admission, the field-size and
pixel-scale guards, and its low-disk reserve. Busy browser requests wait and
retry until admitted or cancelled. Insufficient scratch space fails explicitly
without substituting a smaller observation subset. Metadata storage, execution
time and disk usage grow with the inventory; batching is not a promise of
unlimited capacity. The minimum clipping tile still contains one value per
observation. Large requests can take several minutes or longer.

Completed pixel caches have no automatic expiry. Abnormal process termination
can leave scratch directories; remove only inactive request directories during
maintenance. Running calculations do not resume after a restart. This change
does not create paid resources or change the Lightsail plan.

## Validation

- Regression fixtures process 1,007 inputs even when a historical `limit=1`
  is supplied, checking that every selected observation appears exactly once
  in coadd provenance.
- Full-array versus disk-backed tests cover heterogeneous variance, masks,
  empty pixels, outliers, enabled/disabled sigma clipping, multiple tile
  boundaries, covariance-free variance propagation and wavelength summaries.
- Raw-stack tests verify all 1,007 candidates are attempted, at most two are
  submitted together, pixel payloads are lazy, and equal content is stored once.
- Cleanup and low-disk failure tests check that incomplete coadds are not
  returned as successful subsets.
- Browser regression tests navigate the last of 1,007 lazy frames, retain a
  paused reference while another panel replaces cached pixels, and surface
  lazy-download errors. Existing timeline and detector tests remain enabled.
- `scripts/validate_timeline_batching.py` compares cached real IRSA FITS against
  the full-array reference, checks recorded input hashes when available, and
  records all unavailable inputs. The recorded run used 268 DR1/QR3 candidates;
  259 aligned successfully at 120 arcsec / 3.1 arcsec per pixel. Nine exclusions
  are recorded. All six detectors matched exactly in image and variance arrays,
  with matching coverage, clipping counts and wavelength summaries. This is
  an offline numerical regression, not an independent absolute calibration.
- A 1,200-input, 78×78-pixel synthetic run matched the known mean, variance and
  coverage, using 144.84 MiB peak process RSS in 56.54 seconds on Windows. This
  is not an AWS/cgroup benchmark or a worst-case memory guarantee.
- Chrome checks at 320, 390, 768 and 1440 px found no horizontal overflow;
  coordinates remained visible while scrolling. Real cached SPHEREx frames,
  WISE epochs, lazy navigation, reference selection and all three panels were
  exercised, with no console errors. Automated tests also cover download
  failures and 1,007-frame navigation.

Recorded results: [validation JSON](validation/timeline-batching-2026-11-17.json),
[desktop](validation/timeline-uncapped-desktop.jpg),
[mobile](validation/timeline-uncapped-mobile.jpg).

The current PR contains these changes; the public AWS instance must be updated
to the reviewed commit before its previous 500-input restriction is removed.
