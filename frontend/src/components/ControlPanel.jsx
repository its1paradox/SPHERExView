import { useState } from 'react';
import { openBlinkTab, openSpectrumTab } from '../App.jsx';
import { DEFAULT_DISPLAY } from '../lib/urlstate.js';

const SPHEREX_BANDS = [
  { value: 'SPHEREx-D1', label: 'D1 (0.75\u20131.11 \u00b5m)' },
  { value: 'SPHEREx-D2', label: 'D2 (1.10\u20131.64 \u00b5m)' },
  { value: 'SPHEREx-D3', label: 'D3 (1.63\u20132.42 \u00b5m)' },
  { value: 'SPHEREx-D4', label: 'D4 (2.42\u20133.82 \u00b5m)' },
  { value: 'SPHEREx-D5', label: 'D5 (3.82\u20134.42 \u00b5m)' },
  { value: 'SPHEREx-D6', label: 'D6 (4.42\u20135.00 \u00b5m)' },
];

/**
 * AstroToolBox-style left sidebar: target + FoV + surveys on top, then
 * display controls (zoom, contrast, stretch, blink speed, overlays).
 */
// Accepts "133.786 -7.245", "133.786, -7.245", etc. (decimal degrees).
function parseCoords(text) {
  const parts = text.trim().split(/[\s,;]+/);
  if (parts.length !== 2) return null;
  const ra = parseFloat(parts[0]);
  const dec = parseFloat(parts[1]);
  if (!Number.isFinite(ra) || !Number.isFinite(dec)) return null;
  if (ra < 0 || ra >= 360 || dec < -90 || dec > 90) return null;
  return { ra, dec };
}

export default function ControlPanel({ onSearch, loading, view, setView, form, setForm }) {
  const [coordsError, setCoordsError] = useState(null);
  const set = (key) => (e) => {
    setForm({ ...form, [key]: e.target.value });
    if (key === 'coords') setCoordsError(null);
  };
  const setV = (key, cast = Number) => (e) =>
    setView({ ...view, [key]: cast === 'bool' ? e.target.checked : cast(e.target.value) });
  const toggleBand = (value) => () =>
    setForm((fm) => ({
      ...fm,
      bands: fm.bands.includes(value)
        ? fm.bands.filter((b) => b !== value)
        : [...fm.bands, value],
    }));
  const toggleCombinedDetector = (channel, detector) => () => {
    const key =
      channel === 'short' ? 'combinedShortDetectors' : 'combinedLongDetectors';
    const otherKey =
      channel === 'short' ? 'combinedLongDetectors' : 'combinedShortDetectors';
    setView((current) => {
      const selected = current[key];
      if (selected.includes(detector)) {
        if (selected.length === 1) return current;
        return { ...current, [key]: selected.filter((d) => d !== detector) };
      }
      return {
        ...current,
        [key]: [...selected, detector].sort((a, b) => a - b),
        [otherKey]: current[otherKey].filter((d) => d !== detector),
      };
    });
  };

  const submit = (e) => {
    e.preventDefault();
    const coords = parseCoords(form.coords);
    if (!coords) {
      setCoordsError('Enter RA and Dec in decimal degrees, e.g. 11.889632 28.089606');
      return;
    }
    onSearch({
      ra: coords.ra,
      dec: coords.dec,
      fov: parseFloat(form.fov),
      survey: form.survey,
      band: form.bands.join(','),
      limit: parseInt(form.limit, 10),
      wiseBand: form.wiseBand,
    });
  };

  return (
    <aside className="sidebar">
      <form onSubmit={submit}>
        <fieldset>
          <legend>Target</legend>
          <label>
            Coordinates (RA Dec, deg)
            <input
              value={form.coords}
              onChange={set('coords')}
              placeholder="11.889632 28.089606"
              required
            />
          </label>
          {coordsError && <p className="field-error">{coordsError}</p>}
          <label>
            Field of view (arcsec)
            <input type="number" min="30" max="800" value={form.fov} onChange={set('fov')} />
          </label>
        </fieldset>

        <fieldset>
          <legend>SPHEREx</legend>
          <label>
            Survey
            <select value={form.survey} onChange={set('survey')}>
              <option value="wide">Wide (QR2)</option>
              <option value="deep">Deep (QR2)</option>
            </select>
          </label>
          <div className="band-group">
            <span className="band-group-title">Bands (none checked = all)</span>
            {SPHEREX_BANDS.map((b) => (
              <label className="check band-check" key={b.value}>
                <input
                  type="checkbox"
                  checked={form.bands.includes(b.value)}
                  onChange={toggleBand(b.value)}
                />
                {b.label}
              </label>
            ))}
          </div>
          <label>
            Max frames
            <input type="number" min="1" value={form.limit} onChange={set('limit')} />
          </label>
          <p className="hint">
            SPHEREx frames are reprojected north-up to match the WISE panel.
          </p>
          <label className="check">
            <input
              type="checkbox"
              checked={view.showCoadd}
              onChange={setV('showCoadd', 'bool')}
            />
            Detector CO-ADD panel
          </label>
          <p className="hint">
            Stacks every exposure per detector (zodi-subtracted,
            sky-noise weighted) into one deep image {'\u2014'} SNR grows
            {' \u221d \u221aN'}. Each detector’s LVF mixes wavelengths, so
            coadds are broadband-like, not monochromatic. The last frame is
            a COLOR composite (blue {'<'} 3.8 µm, orange {'>'} 3.8 µm,
            WiseView W1+W2 style): sources that only exist in orange are
            extremely red/cold {'\u2014'} Y-dwarf candidates.
          </p>
        </fieldset>

        <fieldset>
          <legend>WISE</legend>
          <label>
            Band
            <select
              value={form.wiseBand}
              onChange={set('wiseBand')}
              disabled={view.combinedMode === 'wise'}
              title={
                view.combinedMode === 'wise'
                  ? 'The matched combined timeline requires W1+W2 color epochs'
                  : undefined
              }
            >
              <option value="w1">W1 (3.4 µm)</option>
              <option value="w2">W2 (4.6 µm)</option>
              <option value="w1w2">W1+W2 (color)</option>
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={view.showWise} onChange={setV('showWise', 'bool')} />
            Show WISE panel
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={view.showCombined}
              onChange={setV('showCombined', 'bool')}
            />
            Combined WISE {'\u2192'} SPHEREx timeline
          </label>
          {view.showCombined && (
            <>
              <label>
                SPHEREx frames after WISE
                <select
                  value={view.combinedMode}
                  onChange={(event) => {
                    const mode = event.target.value;
                    setView((current) => ({ ...current, combinedMode: mode }));
                    if (mode === 'wise') {
                      setForm((current) => ({ ...current, wiseBand: 'w1w2' }));
                    }
                  }}
                  data-testid="select-combined-mode"
                >
                  <option value="exposures">Raw exposures (all bands)</option>
                  <option value="d6">
                    D6-only epoch coadds {'\u2014'} grayscale W2 bandpass
                  </option>
                  <option value="wise">
                    D4+D6 color coadds {'\u2014'} W1+W2 matched
                  </option>
                  <option value="custom">
                    Configurable color coadds {'\u2014'} maximum depth
                  </option>
                </select>
              </label>
              {view.combinedMode === 'wise' && (
                <p className="hint">
                  D4 (2.42{'\u2013'}3.82 {'\u00b5'}m) occupies the W1 color
                  channel and D6 (4.42{'\u2013'}5.00 {'\u00b5'}m) the W2
                  channel. These frames use the same color mapping,
                  brightness, contrast, stretch and inversion controls as
                  W1+W2 for a continuous mission handoff.
                </p>
              )}
              {view.combinedMode === 'd6' && (
                <p className="hint">
                  A scientifically honest single-band product: only D6 is
                  stacked. No D4 reference is silently mixed into this mode.
                </p>
              )}
              {view.combinedMode !== 'exposures' && (
                <details className="coadd-settings" open={view.combinedMode === 'custom'}>
                  <summary>Epoch coadd recipe</summary>
                  {view.combinedMode === 'custom' && (
                    <>
                      <span className="band-group-title">Blue / short-wavelength channel</span>
                      <div className="detector-grid">
                        {[1, 2, 3, 4, 5, 6].map((detector) => (
                          <label className="check" key={`short-${detector}`}>
                            <input
                              type="checkbox"
                              checked={view.combinedShortDetectors.includes(detector)}
                              disabled={view.combinedLongDetectors.includes(detector)}
                              onChange={toggleCombinedDetector('short', detector)}
                              data-testid={`checkbox-combined-short-d${detector}`}
                            />
                            D{detector}
                          </label>
                        ))}
                      </div>
                      <span className="band-group-title">Orange / long-wavelength channel</span>
                      <div className="detector-grid">
                        {[1, 2, 3, 4, 5, 6].map((detector) => (
                          <label className="check" key={`long-${detector}`}>
                            <input
                              type="checkbox"
                              checked={view.combinedLongDetectors.includes(detector)}
                              disabled={view.combinedShortDetectors.includes(detector)}
                              onChange={toggleCombinedDetector('long', detector)}
                              data-testid={`checkbox-combined-long-d${detector}`}
                            />
                            D{detector}
                          </label>
                        ))}
                      </div>
                      <p className="hint">
                        Default: D1{'\u2013'}D4 versus D5+D6, using all
                        available wavelengths for the deepest two-channel
                        timeline.
                      </p>
                    </>
                  )}
                  <label>
                    Maximum epoch span ({view.combinedMonths} months)
                    <input
                      type="range"
                      min="0.25"
                      max="25"
                      step="0.25"
                      value={view.combinedMonths}
                      onChange={setV('combinedMonths')}
                      data-testid="range-combined-months"
                    />
                  </label>
                  <label>
                    Maximum input exposures
                    <input
                      type="number"
                      min="1"
                      max="10000"
                      value={view.combinedLimit}
                      onChange={setV('combinedLimit')}
                      data-testid="input-combined-limit"
                    />
                  </label>
                  <label>
                    Minimum exposures per channel
                    <input
                      type="number"
                      min="1"
                      max="100"
                      value={view.combinedMinChannelExposures}
                      onChange={setV('combinedMinChannelExposures')}
                      data-testid="input-combined-min-exposures"
                    />
                  </label>
                  <label>
                    Background treatment
                    <select
                      value={view.combinedBackground}
                      onChange={setV('combinedBackground', String)}
                      data-testid="select-combined-background"
                    >
                      <option value="zodi">Subtract zodiacal-light model</option>
                      <option value="none">Keep pipeline background</option>
                    </select>
                  </label>
                  <label>
                    Sigma clipping ({view.combinedSigma === 0 ? 'off' : `${view.combinedSigma}\u03c3`})
                    <input
                      type="range"
                      min="0"
                      max="10"
                      step="0.5"
                      value={view.combinedSigma}
                      onChange={setV('combinedSigma')}
                      data-testid="range-combined-sigma"
                    />
                  </label>
                  <label>
                    Clipping iterations
                    <input
                      type="number"
                      min="0"
                      max="10"
                      value={view.combinedMaxiters}
                      onChange={setV('combinedMaxiters')}
                      data-testid="input-combined-maxiters"
                    />
                  </label>
                  <label>
                    Output pixel scale
                    <select
                      value={view.combinedPixscale}
                      onChange={setV('combinedPixscale')}
                      data-testid="select-combined-pixscale"
                    >
                      <option value="3.1">3.1 arcsec (2x display sampling)</option>
                      <option value="6.2">6.2 arcsec (native sampling)</option>
                    </select>
                  </label>
                  <label>
                    Resampling
                    <select
                      value={view.combinedResampling}
                      onChange={setV('combinedResampling', String)}
                      data-testid="select-combined-resampling"
                    >
                      <option value="bilinear">Bilinear (clearer display)</option>
                      <option value="nearest">Nearest (pixel preserving)</option>
                    </select>
                  </label>
                  <p className="hint">
                    3.1″ bilinear output reduces blockiness and can use
                    sub-pixel visit offsets, but it does not create angular
                    resolution beyond SPHEREx. Use 6.2″ nearest for the most
                    conservative pixel-preserving product.
                  </p>
                </details>
              )}
            </>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={view.showMarkers}
              onChange={setV('showMarkers', 'bool')}
            />
            Gaia DR3 markers
          </label>
        </fieldset>

        <button type="submit" className="fetch-btn" disabled={loading}>
          {loading ? 'Loading\u2026' : 'Fetch images'}
        </button>

        <button
          type="button"
          className="spectrum-btn"
          onClick={() => {
            const coords = parseCoords(form.coords);
            if (!coords) {
              setCoordsError('Enter RA and Dec in decimal degrees, e.g. 11.889632 28.089606');
              return;
            }
            openSpectrumTab(coords.ra, coords.dec);
          }}
        >
          Generate spectrum at target
        </button>
        <button
          type="button"
          className="spectrum-btn"
          onClick={() => {
            const coords = parseCoords(form.coords);
            if (!coords) {
              setCoordsError('Enter RA and Dec in decimal degrees, e.g. 11.889632 28.089606');
              return;
            }
            openBlinkTab(coords.ra, coords.dec, form.fov, form.survey, form.limit);
          }}
        >
          Epoch blink sequence
        </button>
        <p className="hint">
          Spectrum: opens a new tab and extracts a forced-photometry spectrum
          at the target coordinates from all SPHEREx images via IRSA (takes a
          few minutes). Drop a pin on the SPHEREx image to get a spectrum at
          an exact source position instead. Blink sequence: one COLOR coadd per
          sky-pass visit (gap-clustered like unWISE epoch coadds, never split
          by a calendar boundary) {'\u2014'} the WiseView paradigm at SPHEREx
          depth.
        </p>
      </form>

      <fieldset>
        <legend>Display</legend>
        <label>
          Zoom ({view.displaySize}px)
          <input
            type="range"
            min="150"
            max="900"
            step="10"
            value={view.displaySize}
            onChange={setV('displaySize')}
          />
        </label>
        <label>
          Blink speed ({view.speedMs} ms)
          <input
            type="range"
            min="60"
            max="1200"
            step="20"
            value={view.speedMs}
            onChange={setV('speedMs')}
          />
        </label>
      </fieldset>

      <fieldset>
        <legend>SPHEREx display</legend>
        <label>
          Scale
          <select value={view.sxScaleMode} onChange={setV('sxScaleMode', String)}>
            <option value="percentile">Manual black/white point (default)</option>
            <option value="zscale">ZScale (auto)</option>
          </select>
        </label>
        <label className={view.sxScaleMode !== 'percentile' ? 'disabled' : ''}>
          Black point ({view.sxBlackPct}%)
          <input
            type="range"
            min="0"
            max="50"
            step="0.5"
            value={view.sxBlackPct}
            disabled={view.sxScaleMode !== 'percentile'}
            onChange={setV('sxBlackPct')}
          />
        </label>
        <label className={view.sxScaleMode !== 'percentile' ? 'disabled' : ''}>
          White point ({view.sxWhitePct}%)
          <input
            type="range"
            min="80"
            max="100"
            step="0.1"
            value={view.sxWhitePct}
            disabled={view.sxScaleMode !== 'percentile'}
            onChange={setV('sxWhitePct')}
          />
        </label>
        <label>
          Stretch
          <select value={view.sxStretch} onChange={setV('sxStretch', String)}>
            <option value="sqrt">Sqrt (default)</option>
            <option value="asinh">Asinh</option>
            <option value="linear">Linear</option>
            <option value="log">Log</option>
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={view.sxInvert}
            onChange={setV('sxInvert', 'bool')}
          />
          Invert grayscale
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={view.sxSmooth}
            onChange={setV('sxSmooth', 'bool')}
          />
          Smooth pixels (bilinear)
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={view.sxOuter}
            onChange={setV('sxOuter', 'bool')}
          />
          Outer epochs only (blink first &amp; last)
        </label>
        <p className="hint">
          Endpoints default to the very first and last frame. Pick your own
          in the bar under the SPHEREx image (pause on a frame first).
        </p>
      </fieldset>

      <fieldset>
        <legend>WISE display</legend>
        <label>
          Brightness ({view.wiseBrightness})
          <input
            type="range"
            min="1"
            max="100"
            step="1"
            value={view.wiseBrightness}
            onChange={setV('wiseBrightness')}
          />
        </label>
        <label>
          Contrast ({view.wiseContrast})
          <input
            type="range"
            min="1"
            max="100"
            step="1"
            value={view.wiseContrast}
            onChange={setV('wiseContrast')}
          />
        </label>
        <label>
          Stretch
          <select value={view.wiseStretch} onChange={setV('wiseStretch', String)}>
            <option value="linear">Linear (default)</option>
            <option value="asinh">Asinh</option>
            <option value="sqrt">Sqrt</option>
            <option value="log">Log</option>
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={view.wiseInvert}
            onChange={setV('wiseInvert', 'bool')}
          />
          Invert grayscale
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={view.wiseSmooth}
            onChange={setV('wiseSmooth', 'bool')}
          />
          Smooth pixels (bilinear)
        </label>
        <p className="hint">
          Contrast limits come from the first epoch and are shared by all
          frames for a steady blink.
        </p>
        <button
          type="button"
          className="reset-btn"
          onClick={() => setView({ ...view, ...DEFAULT_DISPLAY })}
        >
          Reset display settings
        </button>
      </fieldset>
    </aside>
  );
}
