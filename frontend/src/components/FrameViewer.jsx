import { useEffect, useMemo, useRef, useState } from 'react';
import {
  astroToolboxLimits,
  drawFrame,
  luptonSliderMap,
  percentileLimits,
  pixelToWorld,
  worldToPixel,
  zscaleLimits,
} from '../lib/render.js';

// Pretty-print one metadata value for the frame-info table.
function fmtVal(key, val) {
  if (val === null || val === undefined || val === '') return null;
  if (typeof val === 'number') {
    if (/^em_(min|max)$/.test(key)) return `${(val * 1e6).toFixed(3)} \u00b5m`;
    if (Number.isInteger(val)) return String(val);
    return Math.abs(val) < 1e-3 || Math.abs(val) >= 1e7 ? val.toExponential(6) : String(val);
  }
  if (Array.isArray(val)) {
    // e.g. a coadd's obs_ids / provenance lists: show a few, then a count.
    const shown = val.slice(0, 4).join(', ');
    return val.length > 4 ? `${shown} \u2026 (+${val.length - 4} more)` : shown;
  }
  if (typeof val === 'object') {
    // e.g. lambda_target_um {min_um, weighted_mean_um, max_um, n_sampled}
    return Object.entries(val)
      .map(([k, v]) => `${k}=${typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(4) : v}`)
      .join(' \u00b7 ');
  }
  return String(val);
}

/**
 * Blink viewer for a stack of raw-pixel frames (AstroToolBox style).
 *
 * frames: [{ data: Float32Array, sorted: Float32Array, width, height,
 *            label, sublabel, wcs?, markers? }]
 * render: { mode: 'zscale' | 'percentile' | 'atb', brightness?, contrast?,
 *           blackPct?, whitePct?, stretch, invert, smooth? }
 *   - 'zscale':     per-frame IRAF zscale limits (SPHEREx default look)
 *   - 'percentile': per-frame manual black/white point percentiles
 *   - 'atb':        AstroToolBox limits from the FIRST frame (its W2 array
 *                   for W1+W2 composites), shared by all epochs for a
 *                   steady blink, like AstroToolBox / WiseView
 */
export default function FrameViewer({
  title,
  frames: framesAll,
  render,
  displaySize,
  speedMs,
  showMarkers,
  hoverSky,
  onHoverSky,
  showInfo,
  allowPin,
  onSpectrum,
  outerOnly,
  outerControls,
  pin: pinProp,
  onPin,
}) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [hover, setHover] = useState(null);
  const [infoOpen, setInfoOpen] = useState(false);
  // Pin ({ ra, dec }, sky-anchored): controlled by the parent when `onPin`
  // is given (one shared pin across every panel), else local state.
  const [pinLocal, setPinLocal] = useState(null);
  const pin = onPin ? pinProp : pinLocal;
  const setPin = onPin || setPinLocal;
  const [copied, setCopied] = useState(false);
  const canvasRef = useRef(null);
  const lastPos = useRef(null);
  // Custom outer-blink endpoints (indices into framesAll); null = default.
  const [outerSel, setOuterSel] = useState({ first: null, last: null });

  // Resolved endpoint indices: default to the very first / very last
  // frame, clamp to the stack, and keep them in chronological order.
  const [outerA, outerB] = useMemo(() => {
    const n = framesAll.length;
    if (n === 0) return [0, 0];
    const clamp = (v, dflt) => (v === null ? dflt : Math.max(0, Math.min(v, n - 1)));
    const a = clamp(outerSel.first, 0);
    const b = clamp(outerSel.last, n - 1);
    return a <= b ? [a, b] : [b, a];
  }, [framesAll, outerSel]);

  // "Outer epochs" mode (WiseView-style): blink only the two endpoint
  // frames, back and forth -- middle epochs skipped. If both endpoints
  // resolve to the same frame, show just that one (warned in the UI).
  const frames = useMemo(() => {
    if (!outerOnly || framesAll.length < 2) return framesAll;
    if (outerA === outerB) return [framesAll[outerA]];
    return [framesAll[outerA], framesAll[outerB]];
  }, [framesAll, outerOnly, outerA, outerB]);

  const maxW = useMemo(() => Math.max(1, ...frames.map((f) => f.width)), [frames]);
  const maxH = useMemo(() => Math.max(1, ...frames.map((f) => f.height)), [frames]);
  // Snap to an integer pixel scale when magnifying -- keeps the
  // nearest-neighbour upscale perfectly crisp (uniform pixel blocks).
  const rawScale = displaySize / Math.max(maxW, maxH);
  const scale = rawScale >= 1 ? Math.round(rawScale) : rawScale;

  // Contrast limits, recomputed when the mode/sliders change.
  const limits = useMemo(() => {
    if (frames.length === 0) return [];
    if (render.mode === 'atb') {
      const ref = astroToolboxLimits(
        frames[0].sorted2 || frames[0].sorted,
        render.brightness,
        render.contrast,
      );
      return frames.map(() => ref);
    }
    if (render.mode === 'percentile') {
      return frames.map((f) => percentileLimits(f.sorted, render.blackPct, render.whitePct));
    }
    return frames.map((f) => zscaleLimits(f.sorted));
  }, [
    frames,
    render.mode,
    render.brightness,
    render.contrast,
    render.blackPct,
    render.whitePct,
  ]);

  useEffect(() => {
    setIndex(0);
    setPlaying(true);
    if (!onPin) setPinLocal(null); // shared pin is cleared by the parent
    setCopied(false);
    setOuterSel({ first: null, last: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [framesAll]);

  // Toggling outer-epochs mode: restart the blink (auto-play, so the
  // chosen endpoints start alternating right away) but keep the pin.
  useEffect(() => {
    setIndex(0);
    setPlaying(true);
  }, [outerOnly]);

  // Blink loop.
  useEffect(() => {
    if (!playing || frames.length < 2) return undefined;
    const t = setInterval(() => setIndex((i) => (i + 1) % frames.length), speedMs);
    return () => clearInterval(t);
  }, [playing, frames, speedMs]);

  // Draw current frame.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || frames.length === 0) return;
    const f = frames[Math.min(index, frames.length - 1)];
    const [vmin, vmax] = limits[Math.min(index, limits.length - 1)];
    // Synced crosshair: sky position hovered on the OTHER panel, mapped
    // through THIS frame's WCS.
    let crosshair = null;
    if (hoverSky && hoverSky.source !== title && f.wcs) {
      const p = worldToPixel(f.wcs, hoverSky.ra, hoverSky.dec);
      if (p && p[0] >= 0 && p[1] >= 0 && p[0] < f.width && p[1] < f.height) {
        crosshair = { x: p[0], y: p[1] };
      }
    }
    // Dropped pin: same sky position on every epoch (per-frame WCS).
    let pinPx = null;
    if (pin && f.wcs) {
      const p = worldToPixel(f.wcs, pin.ra, pin.dec);
      if (p && p[0] >= 0 && p[1] >= 0 && p[0] < f.width && p[1] < f.height) {
        pinPx = { x: p[0], y: p[1] };
      }
    }
    drawFrame(canvas, { ...f, vmin, vmax }, {
      scale,
      canvasW: Math.round(maxW * scale),
      canvasH: Math.round(maxH * scale),
      stretch: render.stretch,
      invert: render.invert,
      // Lupton color frames read the sliders through luptonSliderMap so the
      // grayscale percentile defaults land on the pooled positive-intensity
      // scale (95 -> 99.5); grayscale frames ignore these (they use vmin/vmax).
      ...(() => {
        const [b, w] = luptonSliderMap(
          render.mode === 'percentile' ? render.blackPct : undefined,
          render.mode === 'percentile' ? render.whitePct : undefined,
        );
        return { blackPct: b, whitePct: w };
      })(),
      smooth: render.smooth,
      showMarkers,
      crosshair,
      pin: pinPx,
    });
  }, [
    frames,
    index,
    limits,
    scale,
    maxW,
    maxH,
    render.stretch,
    render.invert,
    render.smooth,
    render.mode,
    render.whitePct,
    render.blackPct,
    showMarkers,
    hoverSky,
    title,
    pin,
  ]);

  // Real-time RA/Dec readout under the cursor (per-frame WCS).
  const clearHover = () => {
    setHover(null);
    if (onHoverSky) onHoverSky(null);
  };
  const updateHover = (clientX, clientY) => {
    const canvas = canvasRef.current;
    const f = frames[Math.min(index, frames.length - 1)];
    if (!canvas || !f || !f.wcs) return clearHover();
    const rect = canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) * (canvas.width / rect.width)) / scale;
    const y = ((clientY - rect.top) * (canvas.height / rect.height)) / scale;
    if (x < 0 || y < 0 || x >= f.width || y >= f.height) return clearHover();
    const [ra, dec] = pixelToWorld(f.wcs, x, y);
    setHover({ ra, dec });
    if (onHoverSky) onHoverSky({ ra, dec, source: title });
    return undefined;
  };
  const onMove = (e) => {
    lastPos.current = { x: e.clientX, y: e.clientY };
    updateHover(e.clientX, e.clientY);
  };
  const onLeave = () => {
    lastPos.current = null;
    clearHover();
  };
  // Click drops (or moves) the pin at the clicked sky position.
  const onClick = (e) => {
    if (!allowPin) return;
    const canvas = canvasRef.current;
    const f = frames[Math.min(index, frames.length - 1)];
    if (!canvas || !f || !f.wcs) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) * (canvas.width / rect.width)) / scale;
    const y = ((e.clientY - rect.top) * (canvas.height / rect.height)) / scale;
    if (x < 0 || y < 0 || x >= f.width || y >= f.height) return;
    const [ra, dec] = pixelToWorld(f.wcs, x, y);
    setPin({ ra, dec });
    setCopied(false);
  };
  // Index (into the full stack) of the frame currently on screen.
  const shownAllIdx = outerOnly
    ? [outerA, outerB][Math.min(index, frames.length - 1)]
    : Math.min(index, framesAll.length - 1);
  // Set the currently shown frame as an outer-blink endpoint. Only
  // possible while paused on a frame with the full stack visible.
  const setEndpoint = (which) => {
    if (outerOnly || playing) return;
    setOuterSel((s) => ({ ...s, [which]: shownAllIdx }));
  };
  const pinText = pin ? `${pin.ra.toFixed(6)} ${pin.dec.toFixed(6)}` : '';
  const copyPin = async () => {
    try {
      await navigator.clipboard.writeText(pinText);
    } catch {
      // http fallback
      const ta = document.createElement('textarea');
      ta.value = pinText;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  // Keep the readout in sync while blinking (WCS can differ per frame).
  useEffect(() => {
    if (lastPos.current) updateHover(lastPos.current.x, lastPos.current.y);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, frames, scale]);

  if (frames.length === 0) return null;
  const f = frames[Math.min(index, frames.length - 1)];

  return (
    <section className="panel viewer">
      <h2>{title}</h2>
      <div className="frame-label">
        <span className="band">{f.label}</span>
        <span className="datetime">{f.sublabel}</span>
      </div>
      <canvas ref={canvasRef} onMouseMove={onMove} onMouseLeave={onLeave} onClick={onClick} />
      <div className="coord-readout">
        {hover
          ? `\u03b1 ${hover.ra.toFixed(6)}\u00b0   \u03b4 ${hover.dec >= 0 ? '+' : ''}${hover.dec.toFixed(6)}\u00b0`
          : '\u00a0'}
      </div>
      {allowPin && (
        <div className="pin-bar">
          {pin ? (
            <>
              <span className="pin-dot" aria-hidden="true" />
              <span className="pin-coords">{pinText}</span>
              <button type="button" className="pin-btn" onClick={copyPin}>
                {copied ? 'Copied' : 'Copy'}
              </button>
              {onSpectrum && (
                <button
                  type="button"
                  className="pin-btn"
                  title="Extract an IRSA forced-photometry spectrum at the pin (opens a new tab)"
                  onClick={() => onSpectrum(pin.ra, pin.dec)}
                >
                  Spectrum
                </button>
              )}
              <button type="button" className="pin-btn" onClick={() => setPin(null)}>
                Remove
              </button>
            </>
          ) : (
            <span className="pin-hint">Click the image to drop a pin</span>
          )}
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
          ◀
        </button>
        <button
          type="button"
          onClick={() => {
            setPlaying(false);
            setIndex((i) => (i + 1) % frames.length);
          }}
        >
          ▶
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
      {outerControls && framesAll.length > 1 && (
        <div className="outer-bar">
          <div className="outer-title">
            Outer-blink endpoints
            <span className="outer-note">
              {outerOnly
                ? 'active \u2014 uncheck \u201cOuter epochs only\u201d to change them'
                : 'pause on a frame, then set it as an endpoint'}
            </span>
          </div>
          <div className="outer-row">
            <span className={`outer-chip${!playing && shownAllIdx === outerA ? ' current' : ''}`}>
              <b>First</b>
              {` #${outerA + 1} \u00b7 ${framesAll[outerA].label} \u00b7 ${framesAll[outerA].sublabel}`}
            </span>
            <button
              type="button"
              className="pin-btn"
              disabled={outerOnly || playing}
              onClick={() => setEndpoint('first')}
            >
              Use shown frame
            </button>
          </div>
          <div className="outer-row">
            <span className={`outer-chip${!playing && shownAllIdx === outerB ? ' current' : ''}`}>
              <b>Last</b>
              {` #${outerB + 1} \u00b7 ${framesAll[outerB].label} \u00b7 ${framesAll[outerB].sublabel}`}
            </span>
            <button
              type="button"
              className="pin-btn"
              disabled={outerOnly || playing}
              onClick={() => setEndpoint('last')}
            >
              Use shown frame
            </button>
          </div>
          {outerA === outerB && (
            <div className="outer-warn">
              {'Both endpoints are the same frame \u2014 pick two different frames.'}
            </div>
          )}
          {(outerSel.first !== null || outerSel.last !== null) && (
            <button
              type="button"
              className="pin-btn outer-reset"
              onClick={() => setOuterSel({ first: null, last: null })}
            >
              Reset endpoints to first &amp; last
            </button>
          )}
        </div>
      )}
      {showInfo && !playing && (
        <button type="button" className="info-btn" onClick={() => setInfoOpen((o) => !o)}>
          {infoOpen ? 'Hide frame info' : 'Frame info'}
        </button>
      )}
      {showInfo && !playing && infoOpen && (
        <div className="info-panel">
          <table>
            <tbody>
              {Object.entries(f.metadata || {})
                .map(([k, v]) => [k, fmtVal(k, v)])
                .filter(([, v]) => v !== null)
                .map(([k, v]) => (
                  <tr key={k}>
                    <td className="info-key">{k}</td>
                    <td className="info-val">{v}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          {f.fits_url && (
            <p className="info-links">
              <a href={f.fits_url} target="_blank" rel="noreferrer">
                Download FITS cutout
              </a>
              {(f.metadata || {}).access_url && (
                <>
                  {' \u00b7 '}
                  <a href={f.metadata.access_url} target="_blank" rel="noreferrer">
                    Full exposure FITS
                  </a>
                </>
              )}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
