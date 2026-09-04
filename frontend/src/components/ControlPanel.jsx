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
            Max frames (0 = no limit)
            <input type="number" min="0" value={form.limit} onChange={set('limit')} />
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
            <select value={form.wiseBand} onChange={set('wiseBand')}>
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
            <label>
              SPHEREx frames after WISE
              <select value={view.combinedMode} onChange={setV('combinedMode', String)}>
                <option value="exposures">Raw exposures (all bands)</option>
                <option value="d6">D6 epoch coadds {'\u2014'} W2 bandpass (4.42{'\u2013'}5.00 {'\u00b5'}m)</option>
              </select>
            </label>
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
            <option value="diffuse">Diffuse emission (rings &amp; nebulae)</option>
          </select>
        </label>
        <label className={view.sxScaleMode === 'zscale' ? 'disabled' : ''}>
          {view.sxScaleMode === 'diffuse'
            ? `Sky floor (\u2212${view.sxBlackPct}\u03c3)`
            : `Black point (${view.sxBlackPct}%)`}
          <input
            type="range"
            min="0"
            max="50"
            step="0.5"
            value={view.sxBlackPct}
            disabled={view.sxScaleMode === 'zscale'}
            onChange={setV('sxBlackPct')}
          />
        </label>
        <label className={view.sxScaleMode === 'zscale' ? 'disabled' : ''}>
          {view.sxScaleMode === 'diffuse'
            ? `Ceiling (+${(3.5 * 2 ** ((view.sxWhitePct - 95) / 5)).toFixed(1)}\u03c3)`
            : `White point (${view.sxWhitePct}%)`}
          <input
            type="range"
            min="80"
            max="100"
            step="0.1"
            value={view.sxWhitePct}
            disabled={view.sxScaleMode === 'zscale'}
            onChange={setV('sxWhitePct')}
          />
        </label>
        <label className={view.sxScaleMode === 'diffuse' ? 'disabled' : ''}>
          Stretch{view.sxScaleMode === 'diffuse' ? ' (linear in diffuse mode)' : ''}
          <select
            value={view.sxStretch}
            disabled={view.sxScaleMode === 'diffuse'}
            onChange={setV('sxStretch', String)}
          >
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
        {view.sxScaleMode === 'diffuse' && (
          <p className="hint">
            Diffuse mode suppresses point sources (star-clip to the local
            median), smooths, and shows a narrow linear window just above
            sky {'\u2014'} faint extended structure (rings, shells) stands
            out; stars are intentionally erased. The two sliders set the
            window in sky-noise units: sky floor below the median, ceiling
            above it (lower ceiling = stronger). Best on the detector
            CO-ADDs.
          </p>
        )}
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
        <label className={view.wiseDiffuse ? 'disabled' : ''}>
          Stretch{view.wiseDiffuse ? ' (linear in diffuse mode)' : ''}
          <select
            value={view.wiseStretch}
            disabled={view.wiseDiffuse}
            onChange={setV('wiseStretch', String)}
          >
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
        <label className="check">
          <input
            type="checkbox"
            checked={view.wiseDiffuse}
            onChange={setV('wiseDiffuse', 'bool')}
          />
          Diffuse emission mode (rings &amp; nebulae)
        </label>
        {view.wiseDiffuse && (
          <p className="hint">
            Point sources are clipped to the local median, the image is
            smoothed, and a narrow linear window just above sky is shown
            {'\u2014'} faint extended structure stands out; stars are
            intentionally erased. Brightness deepens the sky floor,
            contrast lowers the ceiling (higher = stronger).
          </p>
        )}
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
