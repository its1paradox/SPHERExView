import { useEffect, useMemo, useRef, useState } from 'react';
import {
  decodeB64Float32,
  drawFrame,
  percentileLimits,
  pixelToWorld,
  sortPixels,
  worldToPixel,
} from '../lib/render.js';
import {
  buildBlinkDataKey,
  buildBlinkHash,
  buildBlinkParams,
  parseBlinkHash,
  validateBlinkGrid,
} from '../lib/blinkstate.js';

/**
 * Time-resolved COLOR epoch blink — the SPHEREx analogue of WiseView.
 *
 * WiseView does not blink raw WISE exposures: it blinks unWISE
 * TIME-RESOLVED COADDS, i.e. one deep stack per 6-month sky pass.  This
 * page ports that exact paradigm to SPHEREx: exposures are clustered into
 * natural sky-pass VISITS (a new epoch starts where the gap between
 * consecutive exposures exceeds ~30 days — the unWISE rule scaled to
 * SPHEREx; continuous polar coverage falls back to balanced time windows),
 * each epoch is stacked into a two-channel color coadd on ONE shared
 * north-up grid, and the epochs blink chronologically.  The default is
 * D1–D4 rendered blue and D5–D6 rendered orange; observers can instead
 * assign any two non-overlapping detector groups to the display channels.
 * Movers drift,
 * variables pulse, and everything static stays pinned — at coadd depth
 * instead of single-exposure noise.
 *
 * Focusing one detector keeps a WiseView-style color composite: the focus
 * detector against a reference channel (D6 focus → D4 reference, the
 * W2/W1 analogue pair), so cold objects still stand out by color.
 *
 * Display limits are computed from ALL frames together (channels are
 * z-scored per bin server-side), so the blink is photometrically and
 * astrometrically rigid.
 */

// Detector choices for single-band blink sequences. 'all' keeps the two-channel
// COLOR stack (blue = D1–D4, orange = D5–D6); a single detector narrows
// each epoch coadd to one wavelength slice.
const BAND_OPTIONS = [
  { value: 'all', label: 'Maximum depth (D1–D4 + D5–D6 COLOR)' },
  { value: 'custom', label: 'Custom detector channels (COLOR)' },
  { value: 'SPHEREx-D1', label: 'D1 focus (0.75\u20131.11 \u00b5m)' },
  { value: 'SPHEREx-D2', label: 'D2 focus (1.10\u20131.64 \u00b5m)' },
  { value: 'SPHEREx-D3', label: 'D3 focus (1.63\u20132.42 \u00b5m)' },
  { value: 'SPHEREx-D4', label: 'D4 focus (2.42\u20133.82 \u00b5m)' },
  { value: 'SPHEREx-D5', label: 'D5 focus (3.82\u20134.42 \u00b5m)' },
  { value: 'SPHEREx-D6', label: 'D6 focus (4.42\u20135.00 \u00b5m) \u2014 W2 bandpass' },
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
  const [form, setForm] = useState(() => parseBlinkHash(window.location.hash));
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
  const buildAbort = useRef(null);
  const buildSequence = useRef(0);
  const appliedDataKey = useRef(null);

  const build = async (f) => {
    const coords = parseCoords(f.coords);
    if (!coords) {
      setError('Enter RA and Dec in decimal degrees, e.g. 133.786 -7.245');
      return;
    }
    const size = Number(f.size);
    const months = Number(f.months);
    const maxframes = Number(f.maxframes);
    const sigma = Number(f.sigma);
    const maxiters = Number(f.maxiters);
    const minChannelExposures = Number(f.minChannelExposures);
    const pixscale = Number(f.pixscale);
    if (!Number.isFinite(size) || size < 30 || size > 7200) {
      setError('Field of view must be between 30 and 7200 arcsec.');
      return;
    }
    if (!Number.isFinite(months) || months < 0.25 || months > 25) {
      setError('Maximum epoch span must be between 0.25 and 25 months.');
      return;
    }
    if (!Number.isInteger(maxframes) || maxframes < 1 || maxframes > 10000) {
      setError('Maximum exposures must be an integer between 1 and 10000.');
      return;
    }
    if (!Number.isFinite(sigma) || sigma < 0 || sigma > 20) {
      setError('Sigma clipping must be between 0 and 20.');
      return;
    }
    if (!Number.isInteger(maxiters) || maxiters < 0 || maxiters > 10) {
      setError('Clipping iterations must be an integer between 0 and 10.');
      return;
    }
    if (
      !Number.isInteger(minChannelExposures) ||
      minChannelExposures < 1 ||
      minChannelExposures > 100
    ) {
      setError('Minimum exposures per channel must be an integer between 1 and 100.');
      return;
    }
    if (!Number.isFinite(pixscale) || pixscale < 1.5 || pixscale > 12) {
      setError('Output pixel scale must be between 1.5 and 12 arcsec.');
      return;
    }
    const gridError = validateBlinkGrid(size, pixscale);
    if (gridError) {
      setError(gridError);
      return;
    }
    if (
      f.band === 'custom' &&
      (!f.shortDetectors.length ||
        !f.longDetectors.length ||
        f.shortDetectors.some((detector) => f.longDetectors.includes(detector)))
    ) {
      setError('Custom color coadds require two non-empty, non-overlapping detector channels.');
      return;
    }
    buildAbort.current?.abort();
    const controller = new AbortController();
    buildAbort.current = controller;
    const sequence = ++buildSequence.current;
    setLoading(true);
    setError(null);
    setFrames([]);
    setPin(null);
    setMeta(null);
    setStatus(
      'Building time-resolved coadds\u2026 every exposure is downloaded, ' +
        'zodi-subtracted and stacked per epoch (a fresh field can take a few minutes).',
    );
    const params = buildBlinkParams(f, coords);
    try {
      const d = await fetch(`/api/epoch-coadds?${params}`, { signal: controller.signal }).then((r) =>
        r.ok ? r.json() : r.json().then((b) => Promise.reject(new Error(b.detail || r.statusText))),
      );
      if (sequence !== buildSequence.current) return;
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
      appliedDataKey.current = buildBlinkDataKey(f, coords);
      setStatus(
        `${d.count} epoch coadds \u00b7 visit-grouped (new epoch when the gap exceeds ` +
          `${d.grouping ? d.grouping.gap_days : 30} d) \u00b7 ` +
          `${d.n_exposures_input - d.n_exposures_skipped} exposures stacked` +
          (d.n_exposures_skipped ? ` (${d.n_exposures_skipped} skipped)` : ''),
      );
      window.location.hash = buildBlinkHash(f, coords);
    } catch (err) {
      if (err.name === 'AbortError' || sequence !== buildSequence.current) return;
      setStatus(null);
      setError(`Blink build failed: ${err.message}`);
    } finally {
      if (sequence === buildSequence.current) {
        setLoading(false);
        if (buildAbort.current === controller) buildAbort.current = null;
      }
    }
  };

  // Auto-build when opened with coordinates in the URL.
  useEffect(() => {
    if (form.coords) build(form);
    return () => buildAbort.current?.abort();
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

  // Lupton color scale, ONE per blink sequence: the pooled positive
  // calibrated intensity distribution I = (X_S + X_L)/2 over ALL epochs
  // (plus the median sky sigma_I).  The renderer derives the white point
  // and black pedestal from it LIVE using the current display percentiles,
  // so the controls respond instantly -- but the distribution itself is
  // pooled across the sequence, so all epochs always share one scale.
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
    return { posSorted: Float64Array.from(pos).sort(), sigI };
  }, [frames]);

  // Reference-channel changes apply WITHOUT pressing Build: auto <-> excess
  // use the identical fetched data (only the rendering differs), so they
  // re-render instantly; switching to/from broad or none changes the
  // detector set and triggers an automatic rebuild.
  const lastRefMode = useRef(form.ref);
  useEffect(() => {
    const prev = lastRefMode.current;
    if (form.ref === prev) return;
    lastRefMode.current = form.ref;
    if (!/^SPHEREx-D[1-6]$/.test(form.band)) return;
    const soft = (r) => r === 'auto' || r === 'excess';
    const coords = parseCoords(form.coords);
    const canReuse =
      coords &&
      frames.length &&
      meta &&
      appliedDataKey.current === buildBlinkDataKey(form, coords);
    if (soft(prev) && soft(form.ref) && canReuse) {
      setMeta((mPrev) => (mPrev ? { ...mPrev, ref: form.ref } : mPrev));
      window.location.hash = buildBlinkHash(form, coords);
    } else {
      build(form);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.ref]);

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
          posSorted: luptonScale.posSorted,
          sigI: luptonScale.sigI,
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
      whitePct,
      blackPct,
      smooth: false,
      showMarkers: false,
      pin: pinPx,
    });
  }, [frames, index, vmin, vmax, displaySize, stretch, invert, pin, luptonScale, meta, whitePct, blackPct]);

  const setF = (key) => (e) =>
    setForm((current) => ({ ...current, [key]: e.target.value }));
  const toggleDetector = (channel, detector) => () => {
    const key = channel === 'short' ? 'shortDetectors' : 'longDetectors';
    const otherKey = channel === 'short' ? 'longDetectors' : 'shortDetectors';
    setForm((current) => {
      const selected = current[key];
      if (selected.includes(detector)) {
        if (selected.length === 1) return current;
        return { ...current, [key]: selected.filter((value) => value !== detector) };
      }
      return {
        ...current,
        [key]: [...selected, detector].sort((a, b) => a - b),
        [otherKey]: current[otherKey].filter((value) => value !== detector),
      };
    });
  };
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
  const refChan = m && m.band_focus
    ? (parseInt(m.band_focus.replace('SPHEREx-D', ''), 10) >= 5 ? m.short_channel : m.long_channel)
    : null;
  const refTag = refChan && refChan.ref_scope === 'full-depth' ? ' (full-depth)' : '';
  const kindLabel = m
    ? m.channels === 'color'
      ? m.band_focus
        ? meta && meta.ref === 'excess'
          ? `${m.band_focus.replace('SPHEREx-', '')} excess (vs ${m.reference}${refTag})`
          : `${m.band_focus.replace('SPHEREx-', '')} + ${m.reference} ref${refTag}`
        : meta?.channel_recipe?.custom
          ? `CUSTOM COLOR · ${fmtDets(m.short_channel?.detectors)} / ${fmtDets(m.long_channel?.detectors)}`
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
  const scienceNote = m
    ? m.channels !== 'color'
      ? 'grayscale = calibrated flux from the selected detector channel; no color ratio is implied'
      : m.channel_recipe?.custom
        ? 'color = calibrated orange/blue display-channel flux ratio (Lupton asinh, chroma gated 2–5σ); interpret hue using the detector assignments shown above'
        : meta?.ref === 'excess'
          ? 'excess view = grayscale reference field plus a single-hue focus-band overlay where focus-minus-reference exceeds 2.5σ'
        : 'color = calibrated long/short flux ratio (Lupton asinh, chroma gated 2–5σ) · an ORANGE source that also MOVES between epochs is a cold, fast-mover candidate'
    : '';

  return (
    <div className="app blink-app">
      <header>
        <h1>SPHERExView {'\u2014'} Epoch blink</h1>
        <p className="subtitle">
          {form.band === 'custom'
            ? `One custom COLOR coadd per sky-pass visit · ${fmtDets(form.shortDetectors)} → blue display channel · ${fmtDets(form.longDetectors)} → orange display channel`
            : form.band && form.band !== 'all'
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
          <fieldset disabled={loading}>
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
              <select
                value={form.band}
                onChange={setF('band')}
                data-testid="select-blink-band"
              >
                {BAND_OPTIONS.map((b) => (
                  <option key={b.value} value={b.value}>
                    {b.label}
                  </option>
                ))}
              </select>
            </label>
            {/^SPHEREx-D[1-6]$/.test(form.band) && (
              <label>
                Reference channel
                <select value={form.ref} onChange={setF('ref')} data-testid="select-blink-ref">
                  {REF_OPTIONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <p className="hint">
              {form.band === 'custom'
                ? `Assign any two non-overlapping detector groups to blue and orange display channels. The defaults preserve wavelength order and maximize depth using D1\u2013D4 versus D5+D6; D4 in blue versus D6 in orange recreates the W1/W2-analogue layout.`
                : form.band !== 'all'
                ? `Hues are anchored to wavelength exactly as in WiseView: the SHORTER band is always blue, the LONGER always orange, everywhere in the app \u2014 a source can never change color because a band was omitted. D6 focus + D4 reference is the detector-level W2/W1 analogue (D4 contains the 3.3 \u00b5m CH4 absorption, D6 the 4.6\u20135 \u00b5m window), so very cold objects glow orange while ordinary stars stay white or bluish.`
                : `The maximum-depth recipe combines all six detectors. Select a focused detector for one wavelength slice or Custom for complete channel control.`}
            </p>
          </fieldset>

          <fieldset disabled={loading}>
            <legend>Coadd recipe</legend>
            {form.band === 'custom' && (
              <>
                <span className="band-group-title">Blue display channel</span>
                <div className="detector-grid">
                  {[1, 2, 3, 4, 5, 6].map((detector) => (
                    <label className="check" key={`blink-short-${detector}`}>
                      <input
                        type="checkbox"
                        checked={form.shortDetectors.includes(detector)}
                        disabled={form.longDetectors.includes(detector)}
                        onChange={toggleDetector('short', detector)}
                        data-testid={`checkbox-blink-short-d${detector}`}
                      />
                      D{detector}
                    </label>
                  ))}
                </div>
                <span className="band-group-title">Orange display channel</span>
                <div className="detector-grid">
                  {[1, 2, 3, 4, 5, 6].map((detector) => (
                    <label className="check" key={`blink-long-${detector}`}>
                      <input
                        type="checkbox"
                        checked={form.longDetectors.includes(detector)}
                        disabled={form.shortDetectors.includes(detector)}
                        onChange={toggleDetector('long', detector)}
                        data-testid={`checkbox-blink-long-d${detector}`}
                      />
                      D{detector}
                    </label>
                  ))}
                </div>
              </>
            )}
            <label>
              Minimum exposures per channel
              <input
                type="number"
                min="1"
                max="100"
                step="1"
                value={form.minChannelExposures}
                onChange={setF('minChannelExposures')}
                data-testid="input-blink-min-exposures"
              />
            </label>
            <label>
              Background treatment
              <select
                value={form.background}
                onChange={setF('background')}
                data-testid="select-blink-background"
              >
                <option value="zodi">Subtract zodiacal-light model</option>
                <option value="none">Keep pipeline background</option>
              </select>
            </label>
            <label>
              Sigma clipping ({Number(form.sigma) === 0 ? 'off' : `${form.sigma}\u03c3`})
              <input
                type="range"
                min="0"
                max="10"
                step="0.5"
                value={form.sigma}
                onChange={setF('sigma')}
                data-testid="range-blink-sigma"
              />
            </label>
            <label>
              Clipping iterations
              <input
                type="number"
                min="0"
                max="10"
                step="1"
                value={form.maxiters}
                onChange={setF('maxiters')}
                data-testid="input-blink-maxiters"
              />
            </label>
            <label>
              Output pixel scale
              <select
                value={form.pixscale}
                onChange={setF('pixscale')}
                data-testid="select-blink-pixscale"
              >
                <option value="3.1">3.1 arcsec (2x display sampling)</option>
                <option value="6.2">6.2 arcsec (native sampling)</option>
              </select>
            </label>
            <label>
              Resampling
              <select
                value={form.resampling}
                onChange={setF('resampling')}
                data-testid="select-blink-resampling"
              >
                <option value="bilinear">Bilinear (clearer display)</option>
                <option value="nearest">Nearest (pixel preserving)</option>
              </select>
            </label>
            <p className="hint">
              3.1″ bilinear output reduces blockiness and uses sub-pixel visit
              offsets with validity-aware variance propagation. It does not
              create angular resolution beyond SPHEREx. Use 6.2″ nearest for
              the conservative pixel-preserving recipe.
            </p>
          </fieldset>

          <fieldset disabled={loading}>
            <legend>Epoch binning</legend>
            <label>
              Maximum epoch span ({form.months} months)
              <input
                type="range"
                min="0.25"
                max="25"
                step="0.25"
                value={form.months}
                onChange={setF('months')}
                data-testid="range-blink-months"
              />
            </label>
            <label>
              Max exposures
              <input
                type="number"
                value={form.maxframes}
                onChange={setF('maxframes')}
                min="1"
                max="10000"
                step="1"
                data-testid="input-blink-maxframes"
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
              {`Black point (${blackPct}%)`}
              <input
                type="range"
                value={blackPct}
                onChange={(e) => setBlackPct(Number(e.target.value))}
                min="0"
                max="20"
                step="0.1"
              />
            </label>
            <label>
              {`White point (${whitePct}%)`}
              <input
                type="range"
                value={whitePct}
                onChange={(e) => setWhitePct(Number(e.target.value))}
                min="80"
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
              {`Color frames use a hue-preserving Lupton composite: ONE stretch is applied to the calibrated intensity and both bands share it, so hue never depends on brightness; pixels below 2\u03c3 joint significance stay neutral gray (full color from 5\u03c3), so blank sky cannot mottle into false colors. All display controls apply instantly \u2014 black/white points set the intensity pedestal and stretch ceiling on ONE scale pooled across ALL epochs (blinking changes are real), and Invert gives a hue-preserving light background: sky turns white while orange stays orange and blue stays blue.`}
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
                  {scienceNote}
                </p>
              )}
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
