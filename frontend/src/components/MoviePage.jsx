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
 * Time-resolved COLOR coadd movie — the SPHEREx analogue of WiseView.
 *
 * WiseView does not blink raw WISE exposures: it blinks unWISE
 * TIME-RESOLVED COADDS, i.e. one deep stack per 6-month sky pass.  This
 * page ports that exact paradigm to SPHEREx: exposures are binned into
 * configurable time windows (default 6 months = one SPHEREx all-sky pass),
 * each bin is stacked into a two-channel color coadd (blue = D1–D4
 * < 3.82 µm, orange = D5–D6 > 3.82 µm) on ONE shared north-up grid, and
 * the bins blink chronologically.  Movers drift, variables pulse, and
 * everything static stays pinned — at coadd depth instead of single-
 * exposure noise.
 *
 * Display limits are computed from ALL frames together (channels are
 * z-scored per bin server-side), so the blink is photometrically and
 * astrometrically rigid.
 */

const MONTH_OPTIONS = [1, 2, 3, 6, 12];

function parseMovieHash() {
  const p = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  return {
    coords: p.get('ra') && p.get('dec') ? `${p.get('ra')} ${p.get('dec')}` : '',
    size: p.get('size') || '240',
    survey: p.get('survey') || 'wide',
    months: p.get('months') || '6',
    maxframes: p.get('maxframes') || '500',
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

export default function MoviePage() {
  const [form, setForm] = useState(parseMovieHash);
  const [frames, setFrames] = useState([]);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [meta, setMeta] = useState(null); // response-level metadata

  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speedMs, setSpeedMs] = useState(500);
  const [displaySize, setDisplaySize] = useState(520);
  const [stretch, setStretch] = useState('sqrt');
  const [invert, setInvert] = useState(true);
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
    try {
      const d = await fetch(`/api/coadd-movie?${params}`).then((r) =>
        r.ok ? r.json() : r.json().then((b) => Promise.reject(new Error(b.detail || r.statusText))),
      );
      const fr = d.frames.map((c) => ({
        ...c,
        data: decodeB64Float32(c.data_b64),
        data2: c.data2_b64 ? decodeB64Float32(c.data2_b64) : null,
      }));
      setFrames(fr);
      setIndex(0);
      setPlaying(true);
      setMeta(d);
      setStatus(
        `${d.count} epoch coadds \u00b7 ${d.bin_months}-month bins \u00b7 ` +
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
      }).toString();
    } catch (err) {
      setStatus(null);
      setError(`Movie build failed: ${err.message}`);
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

  // Blink timer.
  useEffect(() => {
    if (!playing || frames.length < 2) return undefined;
    const t = setInterval(() => setIndex((i) => (i + 1) % frames.length), speedMs);
    return () => clearInterval(t);
  }, [playing, frames, speedMs]);

  // Draw the current epoch.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || frames.length === 0) return;
    const f = frames[Math.min(index, frames.length - 1)];
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
  }, [frames, index, vmin, vmax, displaySize, stretch, invert, pin]);

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

  const kindLabel = m
    ? m.channels === 'color'
      ? 'COLOR'
      : m.channels === 'short-only'
        ? 'short-\u03bb only'
        : 'long-\u03bb only'
    : '';
  const chanSummary = m
    ? [
        m.short_channel ? `${m.short_channel.n_exposures} blue` : null,
        m.long_channel ? `${m.long_channel.n_exposures} orange` : null,
      ]
        .filter(Boolean)
        .join(' / ')
    : '';

  return (
    <div className="app movie-app">
      <header>
        <h1>SPHERExView {'\u2014'} Time-resolved movie</h1>
        <p className="subtitle">
          One COLOR coadd per {form.months}-month sky pass, blinked chronologically {'\u2014'} the
          SPHEREx analogue of WiseView{"'"}s unWISE time-resolved coadds (blue {'<'} 3.82 {'\u00b5'}m
          {' \u00b7 '}orange {'>'} 3.82 {'\u00b5'}m)
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
              SPHEREx sweeps the whole sky every ~6 months, so 6-month bins give one coadd per
              pass {'\u2014'} exactly how unWISE epoch coadds (the frames WiseView blinks) are
              built. Shorter windows resolve the deep-field cadence near the ecliptic poles.
            </p>
          </fieldset>

          <button type="submit" className="fetch-btn" disabled={loading}>
            {loading ? 'Stacking\u2026' : 'Build movie'}
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
              One display scale is shared by ALL epochs (each epoch is z-scored to its own
              sky noise server-side), so brightness changes you see while blinking are real
              relative changes, not stretch artifacts.
            </p>
          </fieldset>
        </form>

        <main className="viewers">
          {status && <p className="status">{status}</p>}
          {error && <p className="status error">{error}</p>}
          {f && (
            <section className="panel viewer movie-viewer">
              <h2>Epoch CO-ADD movie</h2>
              <div className="frame-label">
                <span className="band">{kindLabel}</span>
                <span className="datetime">
                  {m.datetime_min_utc.slice(0, 10)} {'\u2192'} {m.datetime_max_utc.slice(0, 10)}
                  {' \u00b7 '}
                  {m.n_exposures} exp{chanSummary ? ` (${chanSummary})` : ''}
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
                <p className="hint movie-note">
                  {`Grid: ${f.width}\u00d7${f.height}px at ${m.pixscale_arcsec}\u2033/px, north up \u00b7 `}
                  {'units: per-epoch sky-noise \u03c3 \u00b7 an orange-only source that MOVES between '}
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
