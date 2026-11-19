# Restore the WISE–SPHEREx color blink

The intended workflow, present in stable commit `3bd7afb`, is a single sky-aligned
animated image: WISE W1+W2 epochs followed by SPHEREx D4+D6 visit coadds.

## What changed

- On November 17, 2026, deployment-preparation commit `df82fcd` added the
  reference/current two-canvas presentation. This was unrelated to hosting.
- The default `combinedMode: 'wise'` and pixel renderer were not changed to raw
  exposures. However, local-history work in PR #6 saved and restored the full
  view hash, including `cmode=exposures`. The live validation study at
  `(133.7599588, -7.2449993)`, width 120 arcsec, retained that inspection mode.
- Validation evidence for PR #6 recorded the raw 281-frame sequence as a passing
  timeline check. That did not validate the intended color-coadd handoff.
- PR #7 did not introduce the two-canvas layout or change the default coadd mode;
  it retained the earlier behavior. The later live interaction checks were not
  completed. Neither frame counts nor FITS checks alone establish the intended
  viewer workflow.

## Correction

Restore the stable single-image viewer while retaining bounded lazy pixel
loading, local results, uncapped input processing, and current release support.
The dashboard's WISE–SPHEREx link explicitly launches the color blink with
W1+W2 and D4+D6 coadds. It retains the coordinates, field, release, coadd
parameters, and display settings. It does not delete cached products.
Explicit advanced bookmarks still retain their selected mode and offer a
visible action to return to the color blink. The detector launch is unchanged.

## Validation

- 88 frontend tests passed, including a dashboard revisit of a raw-inspection
  recipe with 300 raw frames. The displayed sequence contains WISE epochs and
  color coadds, with one canvas; it does not append the raw inputs.
- Same recorded real observations passed through the stable `3bd7afb` frontend
  and restored frontend: 23 WISE epochs and 3 SPHEREx color coadds. All 26 native
  RGBA images and WCS canvas transforms match exactly. All six calibrated coadd
  channel arrays match exactly. `render.js` is unchanged from the baseline.
- Recorded D4/D6 processing attempted 84 eligible inputs, with 81 contributors
  and 3 explicit no-valid-pixel exclusions. This is recorded-data validation,
  not a fresh archive inventory check or a claim that every input is usable.
- Full 1,007-frame raw inspection/local saving tests continue to pass.

Browser visual verification and deployment of this correction remain pending.
