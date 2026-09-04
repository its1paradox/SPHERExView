import { useEffect, useMemo, useRef, useState } from 'react';
import {
  decodeB64Float32,
  drawFrame,
  percentileLimits,
  pixelToWorld,
  sortPixels,
  worldToPixel,
} from '../lib/render.js';

/**
 * Time-resolved COLOR epoch blink — the SPHEREx analogue of WiseView.
 *
 * WiseView does not blink raw WISE exposures: it blinks unWISE
 * TIME-RESOLVED COADDS, i.e. one deep stack per 6-month sky pass.  This
 * page ports that exact paradigm to SPHEREx: exposures are clustered into
 * natural sky-pass VISITS (a new epoch starts where the gap between
 * consecutive exposures exceeds ~30 days — the unWISE rule scaled to
 * SPHEREx; continuous polar coverage falls back to balanced time windows),
 * each epoch is stacked into a two-channel color coadd (D1–D4 < 3.82 µm
 * rendered blue, D5–D6 > 3.82 µm rendered orange) on ONE shared north-up
 * grid, and the epochs blink chronologically.  Movers drift, variables
 * pulse, and everything static stays pinned — at coadd depth instead of
 * single-exposure noise.
 *
 * Focusing one detector keeps a WiseView-style color composite: the focus
 * detector against a reference channel (D6 focus → D4 reference, the
 * W2/W1 analogue pair), so cold objects still stand out by color.
 *
 * Display limits are computed from ALL frames together (channels are
 * z-scored per bin server-side), so the blink is photometrically and
 * astrometrically rigid.
 */

const MONTH_OPTIONS = [1, 2, 3, 6, 12];

// Detector choices for single-band blink sequences. 'all' keeps the two-channel
// COLOR stack (blue = D1–D4, orange = D5–D6); a single detector narrows
// each epoch coadd to one wavelength slice.
const BAND_OPTIONS = [
  { value: 'all', label: 'All 6 detectors (COLOR)' },
  { value: 'SPHEREx-D1', label: 'D1 focus (0.75\u20131.11 \u00b5m)' },
  { value: 'SPHEREx-D2', label: 'D2 focus (1.10\u20131.64 \u00b5m)' },
  { value: 'SPHEREx-D3', label: 'D3 focus (1.63\u20132.42 \u00b5m)' },
  { value: 'SPHEREx-D4', label: 'D4 focus (2.42\u20133.82 \u00b5m)' },
  { value: 'SPHEREx-D5', label: 'D5 focus (3.82\u20134.42 \u00b5m)' },
  { value: 'SPHEREx-D6', label: 'D6 focus (4.42\u20135.00 \u00b5m) \u2014 W2 successor' },
];

// Reference channel for a focused blink: keeps the two-channel WiseView
// color contrast (W1/W2 paradigm) even when isolating one detector.
const REF_OPTIONS = [
  { value: 'auto', label: 'W-analogue counterpart (D4 \u2194 D6) \u2014 two-color' },
  { value: 'excess', label: 'Excess finder \u2014 gray field + focus-band excess' },
  { value: 'broad', label: 'Broad complementary side \u2014 two-color' },
  { value: 'none', label: 'None \u2014 grayscale slice' },
];

const median = (arr) => {
  const s = Float64Array.from(arr).sort();
  return s.length ? s[s.length >> 1] : 0;
};

const fmtDets = (dets) => {
  if (!dets || !dets.length) return '';
  const s = dets[0];
  const e = dets[dets.length - 1];
  return dets.length > 1 && e - s + 1 === dets.length
    ? `D${s}\u2013D${e}`
    : dets.map((d) => `D${d}`).join('+');
};

function parseBlinkHash() {
  const p = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  return {
    coords: p.get('ra') && p.get('dec') ? `${p.get('ra')} ${p.get('dec')}` : '',
    size: p.get('size') || '240',
    survey: p.get('survey') || 'wide',
    months: p.get('months') || '6',
    maxframes: p.get('maxframes') || '500',
    band: p.get('band') || 'all',
    ref: p.get('ref') || 'auto',
  };
}

function parseCoords(text) {
  const parts = text.trim().split(/[\s,;]+/);
  if (parts.length !== 2) return null;
  const ra = parseFloat(parts[0]);
  const dec = parseFloat(parts[1]);
  if (!Number.isFinite(ra) || !Number.isFinite(dec)) return null;
  if (ra < 0 || ra >= 360 || dec < -90 || dec > 90) return null;
  return { ra, dec };
}

function fmtVal(v, depth = 0) {
  if (v == null) return '—';
  if (Array.isArray(v)) return v.map((x) => fmtVal(x, depth + 1)).join(', ');
  if (typeof v === 'object') {
    const body = Object.entries(v)
      .map(([k, x]) => `${k}=${fmtVal(x, depth + 1)}`)
      .join(' · ');
    return depth > 0 ? `(${body})` : body;
  }
  if (typeof v === 'number' && !Number.isInteger(v)) return String(Math.round(v * 1e5) / 1e5);
  return String(v);
}

export default function BlinkPage() {
  const [form, setForm] = useState(parseBlinkHash);
  const [frames, setFrames] = useState([]);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [meta, setMeta] = useState(null); // response-level metadata

  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speedMs, setSpeedMs] = useState(500);
  const [displaySize, setDisplaySize] = useState(520);
  const [stretch, setStretch] = useState('asinh');
  const [invert, setInvert] = useState(false);
  const [blackPct, setBlackPct] = useState(0.5);
  const [whitePct, setWhitePct] = useState(99.5);
  const [hover, setHover] = useState(null);
  const [pin, setPin] = useState(null);
  const [copied, setCopied] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const canvasRef = useRef(null);

  const build = async (f) => {
    const coords = parseCoords(f.coords);
    if (!coords) {
      setError('Enter RA and Dec in decimal degrees, e.g. 133.786 -7.245');
      return;
    }
    setLoading(true);
    setError(null);
    setFrames([]);
    setPin(null);
    setMeta(null);
    setStatus(
      'Building time-resolved coadds\u2026 every exposure is downloaded, ' +
        'zodi-subtracted and stacked per epoch (a fresh field can take a few minutes).',
    );
    const params = new URLSearchParams({
      ra: coords.ra,
      dec: coords.dec,
      radius_arcsec: parseFloat(f.size) / 2,
      survey: f.survey,
      bin_months: f.months,
      limit: f.maxframes,
    });
    if (f.band && f.band !== 'all') {
      params.set('band', f.band);
      params.set('ref', f.ref || 'auto');
    }
    try {
      const d = await fetch(`/api/epoch-coadds?${params}`).then((r) =>
        r.ok ? r.json() : r.json().then((b) => Promise.reject(new Error(b.detail || r.statusText))),
      );
      const fr = d.frames.map((c) => ({
        ...c,
        data: decodeB64Float32(c.data_b64),
        data2: c.data2_b64 ? decodeB64Float32(c.data2_b64) : null,
        // Per-channel sky sigma (MJy/sr): multiplying the z-scored pixels
        // back restores calibrated surface brightness, so color comes from
        // the physical flux ratio, not per-channel display gains.
        sigmaS: c.metadata?.short_channel?.sky_sigma_mjy_sr || null,
        sigmaL: c.metadata?.long_channel?.sky_sigma_mjy_sr || null,
      }));
      setFrames(fr);
      setIndex(0);
      setPlaying(true);
      setMeta(d);
      setStatus(
        `${d.count} epoch coadds \u00b7 visit-grouped (new epoch when the gap exceeds ` +
          `${d.grouping ? d.grouping.gap_days : 30} d) \u00b7 ` +
          `${d.n_exposures_input - d.n_exposures_skipped} exposures stacked` +
          (d.n_exposures_skipped ? ` (${d.n_exposures_skipped} skipped)` : ''),
      );
      window.location.hash = new URLSearchParams({
        ra: coords.ra,
        dec: coords.dec,
        size: f.size,
        survey: f.survey,
        months: f.months,
        maxframes: f.maxframes,
        ...(f.band && f.band !== 'all' ? { band: f.band, ref: f.ref || 'auto' } : {}),
      }).toString();
    } catch (err) {
      setStatus(null);
      setError(`Blink build failed: ${err.message}`);
    }
    setLoading(false);
  };

  // Auto-build when opened with coordinates in the URL.
  useEffect(() => {
    if (form.coords) build(form);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ONE set of display limits across every epoch (and both channels): the
  // frames are per-bin z-scored server-side, so a shared percentile cut in
  // sigma units keeps the blink rigid.
  const sharedSorted = useMemo(() => {
    if (!frames.length) return null;
    let total = 0;
    for (const f of frames) total += f.data.length + (f.data2 ? f.data2.length : 0);
    const all = new Float32Array(total);
    let o = 0;
    for (const f of frames) {
      all.set(f.data, o);
      o += f.data.length;
      if (f.data2) {
        all.set(f.data2, o);
        o += f.data2.length;
      }
    }
    return sortPixels(all);
  }, [frames]);

  const [vmin, vmax] = useMemo(
    () => (sharedSorted ? percentileLimits(sharedSorted, blackPct, whitePct) : [0, 1]),
    [sharedSorted, blackPct, whitePct],
  );

  // Frozen Lupton color scale, ONE per blink sequence (never re-estimated
  // frame by frame): white point W = the white-point percentile of the
  // pooled positive calibrated intensity I = (X_S + X_L)/2, floored at
  // 25 sigma_I so a starless field cannot over-stretch the sky.
  const luptonScale = useMemo(() => {
    const cf = frames.filter((f) => f.data2 && f.sigmaS && f.sigmaL);
    if (!cf.length) return null;
    const sigI = median(cf.map((f) => 0.5 * Math.hypot(f.sigmaS, f.sigmaL)));
    const pos = [];
    for (const f of cf) {
      for (let i = 0; i < f.data.length; i += 1) {
        const I = 0.5 * (Math.max(0, f.data[i]) * f.sigmaS + Math.max(0, f.data2[i]) * f.sigmaL);
        if (I > 0) pos.push(I);
      }
    }
    if (!pos.length) return null;
    const sorted = Float64Array.from(pos).sort();
    const W = Math.max(
      sorted[Math.min(sorted.length - 1, Math.round((whitePct / 100) * (sorted.length - 1)))],
      25 * sigI,
    );
    return { W, sigI };
  }, [frames, whitePct]);

  // Blink timer.
  useEffect(() => {
    if (!playing || frames.length < 2) return undefined;
    const t = setInterval(() => setIndex((i) => (i + 1) % frames.length), speedMs);
    return () => clearInterval(t);
  }, [playing, frames, speedMs]);

  // Draw the current epoch.  Single-channel epochs (ref=none) are rendered
  // as an explicitly labeled GRAYSCALE slice \u2014 a lone band carries no color
  // information, so painting it orange or blue would fake a color claim
  // (wavelength-anchored semantics: hue is only ever computed from a real
  // short/long flux ratio).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || frames.length === 0) return;
    let f = frames[Math.min(index, frames.length - 1)];
    if (f.data2 && f.sigmaS && f.sigmaL && luptonScale) {
      const focus = f.metadata?.band_focus || null; // what was actually built
      f = {
        ...f,
        colorScale: {
          sigmaS: f.sigmaS,
          sigmaL: f.sigmaL,
          W: luptonScale.W,
          sat: focus ? 1.25 : 1.15,
          mode: focus && meta && meta.ref === 'excess' ? 'excess' : 'color',
          focusLong: focus ? parseInt(focus.replace('SPHEREx-D', ''), 10) >= 5 : true,
        },
      };
    }
    const scale = displaySize / Math.max(f.width, f.height);
    let pinPx = null;
    if (pin && f.wcs) {
      const p = worldToPixel(f.wcs, pin.ra, pin.dec);
      if (p && p[0] >= 0 && p[1] >= 0 && p[0] < f.width && p[1] < f.height) {
        pinPx = { x: p[0], y: p[1] };
      }
    }
    drawFrame(canvas, { ...f, vmin, vmax }, {
      scale,
      canvasW: Math.round(f.width * scale),
      canvasH: Math.round(f.height * scale),
      stretch,
      invert,
      smooth: false,
      showMarkers: false,
      pin: pinPx,
    });
  }, [frames, index, vmin, vmax, displaySize, stretch, invert, pin, luptonScale, meta]);

  const setF = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  const f = frames.length ? frames[Math.min(index, frames.length - 1)] : null;
  const m = f ? f.metadata : null;

  const toSky = (clientX, clientY) => {
    const canvas = canvasRef.current;
    if (!canvas || !f || !f.wcs) return null;
    const rect = canvas.getBoundingClientRect();
    const scale = displaySize / Math.max(f.width, f.height);
    const x = ((clientX - rect.left) * (canvas.width / rect.width)) / scale;
    const y = ((clientY - rect.top) * (canvas.height / rect.height)) / scale;
    if (x < 0 || y < 0 || x >= f.width || y >= f.height) return null;
    const [ra, dec] = pixelToWorld(f.wcs, x, y);
    return { ra, dec };
  };

  const soloDetectors = m && m.channels !== 'color'
    ? (m.channels === 'short-only' ? m.short_channel : m.long_channel)?.detectors
    : null;
  const kindLabel = m
    ? m.channels === 'color'
      ? m.band_focus
        ? meta && meta.ref === 'excess'
          ? `${m.band_focus.replace('SPHEREx-', '')} excess (vs ${m.reference})`
          : `${m.band_focus.replace('SPHEREx-', '')} + ${m.reference} ref`
        : 'COLOR'
      : soloDetectors && soloDetectors.length === 1
        ? `D${soloDetectors[0]} \u00b7 grayscale`
        : m.channels === 'short-only'
          ? 'short-\u03bb \u00b7 grayscale'
          : 'long-\u03bb \u00b7 grayscale'
    : '';
  const chanSummary = m
    ? [
        m.short_channel
          ? `${m.short_channel.n_exposures} ${fmtDets(m.short_channel.detectors)}`
          : null,
        m.long_channel
          ? `${m.long_channel.n_exposures} ${fmtDets(m.long_channel.detectors)}`
          : null,
      ]
        .filter(Boolean)
        .join(' / ')
    : '';

  return (
    <div className="app blink-app">
      <header>
        <h1>SPHERExView {'\u2014'} Epoch blink</h1>
        <p className="subtitle">
          {form.band && form.band !== 'all'
            ? form.ref === 'none'
              ? `One ${form.band.replace('SPHEREx-', '')}-only coadd per sky-pass visit, blinked chronologically \u2014 an explicitly grayscale wavelength slice (a lone band carries no color information)`
              : form.ref === 'excess'
                ? `${form.band.replace('SPHEREx-', '')} excess finder \u2014 grayscale field, with color ONLY where ${form.band.replace('SPHEREx-', '')} is in \u22652.5\u03c3 excess over the reference band (reference noise can never paint color)`
                : `${form.band.replace('SPHEREx-', '')}-focused color blink \u2014 one coadd per sky-pass visit, the focus detector against a reference channel in the exact WiseView color language (short \u2192 blue \u00b7 long \u2192 orange \u00b7 equal \u2192 white)`
            : `One COLOR coadd per sky-pass visit, blinked chronologically \u2014 the SPHEREx analogue of WiseView's unWISE time-resolved coadds (D1\u2013D4 \u2192 blue \u00b7 D5\u2013D6 \u2192 orange \u00b7 equal \u2192 white \u00b7 sky \u2192 neutral gray)`}
        </p>
      </header>
      <div className="layout">
        <form
          className="sidebar"
          onSubmit={(e) => {
            e.preventDefault();
            build(form);
          }}
        >
          <fieldset>
            <legend>Target</legend>
            <label>
              Coordinates (RA Dec, deg)
              <input value={form.coords} onChange={setF('coords')} placeholder="133.786 -7.245" />
            </label>
            <label>
              Field of view (arcsec)
              <input type="number" value={form.size} onChange={setF('size')} min="30" step="10" />
            </label>
            <label>
              Survey
              <select value={form.survey} onChange={setF('survey')}>
                <option value="wide">Wide (QR2)</option>
                <option value="deep">Deep (QR2)</option>
              </select>
            </label>
            <label>
              Detector band
              <select value={form.band} onChange={setF('band')}>
                {BAND_OPTIONS.map((b) => (
                  <option key={b.value} value={b.value}>
                    {b.label}
                  </option>
                ))}
              </select>
            </label>
            {form.band !== 'all' && (
              <label>
                Reference channel
                <select value={form.ref} onChange={setF('ref')}>
                  {REF_OPTIONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <p className="hint">
              {form.band !== 'all'
                ? `Hues are anchored to wavelength exactly as in WiseView: the SHORTER band is always blue, the LONGER always orange, everywhere in the app \u2014 a source can never change color because a band was omitted. D6 focus + D4 reference is the detector-level W2/W1 analogue (D4 contains the 3.3 \u00b5m CH4 absorption, D6 the 4.6\u20135 \u00b5m window), so very cold objects glow orange while ordinary stars stay white or bluish.`
                : `A single detector focuses every epoch coadd on one wavelength slice \u2014 D6 (4.42\u20135.00 \u00b5m) is the closest match to WISE W2 (4.6 \u00b5m).`}
            </p>
          </fieldset>

          <fieldset>
            <legend>Epoch binning</legend>
            <label>
              Coadd window
              <select value={form.months} onChange={setF('months')}>
                {MONTH_OPTIONS.map((mo) => (
                  <option key={mo} value={mo}>
                    {mo} month{mo > 1 ? 's' : ''}
                    {mo === 6 ? ' (one sky pass)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Max exposures
              <input
                type="number"
                value={form.maxframes}
                onChange={setF('maxframes')}
                min="1"
                max="2000"
                step="1"
              />
            </label>
            <p className="hint">
              Epochs follow the natural SPHEREx visit structure: a new epoch starts where
              consecutive exposures are more than ~30 days apart (the unWISE gap rule scaled
              to SPHEREx), so a sky-pass visit is never split by an arbitrary calendar
              boundary. The window above only caps the epoch span {'\u2014'} continuous
              polar (deep-field) coverage is subdivided into balanced windows of this length.
            </p>
          </fieldset>

          <button type="submit" className="fetch-btn" disabled={loading}>
            {loading ? 'Stacking\u2026' : 'Build blink sequence'}
          </button>

          <fieldset>
            <legend>Display</legend>
            <label>
              Zoom ({displaySize}px)
              <input
                type="range"
                min="260"
                max="900"
                step="20"
                value={displaySize}
                onChange={(e) => setDisplaySize(Number(e.target.value))}
              />
            </label>
            <label>
              Blink speed ({speedMs} ms)
              <input
                type="range"
                min="150"
                max="2000"
                step="50"
                value={speedMs}
                onChange={(e) => setSpeedMs(Number(e.target.value))}
              />
            </label>
            <label>
              Stretch
              <select value={stretch} onChange={(e) => setStretch(e.target.value)}>
                <option value="linear">linear</option>
                <option value="sqrt">sqrt</option>
                <option value="asinh">asinh</option>
                <option value="log">log</option>
              </select>
            </label>
            <label>
              Black point (percentile)
              <input
                type="number"
                value={blackPct}
                onChange={(e) => setBlackPct(Number(e.target.value))}
                min="0"
                max="50"
                step="0.5"
              />
            </label>
            <label>
              White point (percentile)
              <input
                type="number"
                value={whitePct}
                onChange={(e) => setWhitePct(Number(e.target.value))}
                min="50"
                max="100"
                step="0.1"
              />
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={invert}
                onChange={(e) => setInvert(e.target.checked)}
              />
              Invert (light background)
            </label>
            <p className="hint">
              {`Color frames use a hue-preserving Lupton composite: ONE stretch is applied to the calibrated intensity and both bands share it, so hue never depends on brightness; pixels below 2\u03c3 joint significance stay neutral gray (full color from 5\u03c3), so blank sky cannot mottle into false colors. One frozen display scale is shared by ALL epochs \u2014 blinking changes are real. Black point is fixed at sky (0) for color frames; the percentiles drive grayscale slices.`}
            </p>
          </fieldset>
        </form>

        <main className="viewers">
          {status && <p className="status">{status}</p>}
          {error && <p className="status error">{error}</p>}
          {f && (
            <section className="panel viewer blink-viewer">
              <h2>Epoch CO-ADD blink</h2>
              <div className="frame-label">
                <span className="band">{kindLabel}</span>
                <span className="datetime">
                  {m.datetime_min_utc.slice(0, 10)} {'\u2192'} {m.datetime_max_utc.slice(0, 10)}
                  {' \u00b7 '}
                  {m.n_exposures} exp{chanSummary ? ` (${chanSummary})` : ''}
                  {m.grouping ? ` \u00b7 ${m.grouping === 'visit' ? 'sky-pass visit' : 'time window'}` : ''}
                  {m.shallow ? ' \u00b7 shallow (<5 exp)' : ''}
                </span>
              </div>
              <canvas
                ref={canvasRef}
                onMouseMove={(e) => setHover(toSky(e.clientX, e.clientY))}
                onMouseLeave={() => setHover(null)}
                onClick={(e) => {
                  const sky = toSky(e.clientX, e.clientY);
                  if (sky) {
                    setPin(sky);
                    setCopied(false);
                  }
                }}
              />
              <div className="coord-readout">
                {hover
                  ? `\u03b1 ${hover.ra.toFixed(6)}\u00b0 \u00b7 \u03b4 ${hover.dec.toFixed(6)}\u00b0`
                  : 'hover for RA/Dec \u00b7 click to drop a pin'}
              </div>
              {pin && (
                <div className="pin-bar">
                  <span className="pin-dot" />
                  <span className="pin-coords">
                    {pin.ra.toFixed(6)} {pin.dec.toFixed(6)}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard
                        .writeText(`${pin.ra.toFixed(6)} ${pin.dec.toFixed(6)}`)
                        .then(() => setCopied(true));
                    }}
                  >
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      window.open(
                        `spectrum.html#ra=${pin.ra.toFixed(6)}&dec=${pin.dec.toFixed(6)}`,
                        '_blank',
                        'noopener',
                      )
                    }
                  >
                    Spectrum
                  </button>
                  <button type="button" onClick={() => setPin(null)}>
                    Remove
                  </button>
                </div>
              )}
              <div className="controls">
                <button type="button" onClick={() => setPlaying((p) => !p)}>
                  {playing ? 'Pause' : 'Play'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPlaying(false);
                    setIndex((i) => (i - 1 + frames.length) % frames.length);
                  }}
                >
                  {'\u25c0'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPlaying(false);
                    setIndex((i) => (i + 1) % frames.length);
                  }}
                >
                  {'\u25b6'}
                </button>
                <input
                  type="range"
                  min="0"
                  max={frames.length - 1}
                  value={Math.min(index, frames.length - 1)}
                  onChange={(e) => {
                    setPlaying(false);
                    setIndex(Number(e.target.value));
                  }}
                />
                <span className="frame-count">
                  {Math.min(index, frames.length - 1) + 1}/{frames.length}
                </span>
              </div>
              <div className="frame-actions">
                <button type="button" className="info-btn" onClick={() => setInfoOpen((o) => !o)}>
                  {infoOpen ? 'Hide info' : 'Epoch info'}
                </button>
              </div>
              {infoOpen && (
                <div className="info-panel">
                  <table>
                    <tbody>
                      {Object.entries(m).map(([k, v]) => (
                        <tr key={k}>
                          <td className="info-key">{k}</td>
                          <td className="info-val">{fmtVal(v)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {meta && (
                <p className="hint blink-note">
                  {`Grid: ${f.width}\u00d7${f.height}px at ${m.pixscale_arcsec}\u2033/px, north up \u00b7 `}
                  {'color = calibrated long/short flux ratio (Lupton asinh, chroma gated 2\u20135\u03c3) \u00b7 '}
                  {'an ORANGE source (bright long-\u03bb, faint short-\u03bb) that MOVES between '}
                  {'epochs is a cold, fast mover \u2014 the WISE 0855\u22120714 signature'}
                </p>
              )}
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
