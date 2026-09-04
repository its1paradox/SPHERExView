import { useEffect, useMemo, useRef, useState } from 'react';
import {
  astroToolboxLimits,
  percentileLimits,
  renderOffscreen,
  worldToPixel,
  zscaleLimits,
} from '../lib/render.js';

// Combined WISE -> SPHEREx chronological timeline.
//
// All frames (unWISE epochs and SPHEREx exposures) play as ONE time-ordered
// sequence in a shared sky frame: the canvas shows exactly `fov` arcseconds
// centred on the search target, north up, east left, at a fixed
// arcsec-per-screen-pixel scale.  Each mission frame is placed with an
// affine transform derived from its own WCS (local east/north basis vectors
// evaluated at the target via the exact TAN projection), so position, scale,
// rotation, and parity are all correct per frame -- a mover like Barnard's
// star travels in one continuous direction across the mission boundary.

// Local Jacobian of the frame's display-pixel grid at the target position:
// image-pixel offsets per arcsecond of true east and true north motion.
// Uses the exact worldToPixel (TAN) with a +-6" baseline; over 12" the
// projection is linear to << 1 milli-pixel, so this is effectively exact.
function eastNorthBasis(wcs, ra0, dec0) {
  const p0 = worldToPixel(wcs, ra0, dec0);
  if (!p0) return null;
  const d = 6 / 3600; // 6 arcsec in degrees
  const cosd = Math.cos((dec0 * Math.PI) / 180);
  const pE = worldToPixel(wcs, ra0 + d / cosd, dec0);
  const pN = worldToPixel(wcs, ra0, dec0 + d);
  if (!pE || !pN) return null;
  return {
    p0,
    // image px per arcsec of eastward / northward sky motion
    eE: [(pE[0] - p0[0]) / 6, (pE[1] - p0[1]) / 6],
    eN: [(pN[0] - p0[0]) / 6, (pN[1] - p0[1]) / 6],
  };
}

// Canvas affine (setTransform args) that maps image pixels to screen pixels
// such that the target lands at the canvas centre, north is up, east is
// left, and 1 screen px = fov/size arcsec.  screen = A * image + t with
// A = S_screen * M^-1 where M = [eE eN] (image px per arcsec east/north)
// and S_screen = [[-s, 0], [0, -s]] (east left, north up), s = size/fov.
function frameTransform(basis, size, fov) {
  const s = size / fov; // screen px per arcsec
  const [a11, a21] = basis.eE; // M columns
  const [a12, a22] = basis.eN;
  const det = a11 * a22 - a12 * a21;
  if (!det) return null;
  // M^-1 rows
  const i11 = a22 / det;
  const i12 = -a12 / det;
  const i21 = -a21 / det;
  const i22 = a11 / det;
  // A = diag(-s, -s) . M^-1
  const A = [-s * i11, -s * i12, -s * i21, -s * i22];
  const cx = size / 2;
  const cy = size / 2;
  return {
    a: A[0],
    b: A[2],
    c: A[1],
    d: A[3],
    e: cx - (A[0] * basis.p0[0] + A[1] * basis.p0[1]),
    f: cy - (A[2] * basis.p0[0] + A[3] * basis.p0[1]),
  };
}

const fmtDate = (f) => (f.sublabel ? f.sublabel.slice(0, 10) : '');

export default function CombinedViewer({
  wiseFrames,
  spherexFrames,
  target, // { ra, dec }
  fov, // arcsec shown by the combined canvas
  view, // full display settings (both missions)
  displaySize,
  speedMs,
  pin, // shared sky-anchored pin { ra, dec } (same one as the other panels)
  onPin,
}) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const canvasRef = useRef(null);

  // Sky <-> screen in the fixed shared frame: target at centre, north up,
  // east left, displaySize/fov screen px per arcsec (small-angle, exact to
  // well under a pixel at these fields).
  const s = displaySize / fov;
  const skyToScreen = (ra, dec) => {
    const cosd = Math.cos((target.dec * Math.PI) / 180);
    const dE = (ra - target.ra) * cosd * 3600;
    const dN = (dec - target.dec) * 3600;
    return [displaySize / 2 - s * dE, displaySize / 2 - s * dN];
  };
  const screenToSky = (x, y) => {
    const cosd = Math.cos((target.dec * Math.PI) / 180);
    const dE = (displaySize / 2 - x) / s;
    const dN = (displaySize / 2 - y) / s;
    return [target.ra + dE / 3600 / cosd, target.dec + dN / 3600];
  };

  // Click drops (or moves) the shared pin at the clicked sky position.
  const onClick = (e) => {
    if (!onPin) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);
    const [ra, dec] = screenToSky(x, y);
    onPin({ ra, dec });
  };

  // Chronological merge. Each entry keeps its mission so the right
  // stretch/limits/invert settings apply per frame.
  const frames = useMemo(() => {
    const wise = wiseFrames.map((f) => ({ f, mission: 'WISE', mjd: f.mjd }));
    const sx = spherexFrames.map((f) => ({
      f,
      mission: 'SPHEREx',
      mjd: f.metadata?.mjd_mid ?? f.metadata?.mjd,
    }));
    return [...wise, ...sx]
      .filter(
        (e) =>
          Number.isFinite(e.mjd) &&
          e.f.wcs &&
          // Skip SPHEREx exposures whose footprint doesn't include the
          // target (cone-matched but only clipping the field edge) --
          // they would show an empty frame at the object's position.
          e.f.metadata?.target_covered !== false,
      )
      .sort((x, y) => x.mjd - y.mjd);
  }, [wiseFrames, spherexFrames]);

  const skippedNoCoverage = useMemo(
    () => spherexFrames.filter((f) => f.metadata?.target_covered === false).length,
    [spherexFrames],
  );

  // Contrast limits per mission (same algorithms as the panels above).
  const limits = useMemo(() => {
    const wiseRef = wiseFrames.length
      ? astroToolboxLimits(
          wiseFrames[0].sorted2 || wiseFrames[0].sorted,
          view.wiseBrightness,
          view.wiseContrast,
        )
      : [0, 1];
    return frames.map((e) => {
      if (e.mission === 'WISE') return wiseRef;
      if (view.sxScaleMode === 'percentile') {
        return percentileLimits(e.f.sorted, view.sxBlackPct, view.sxWhitePct);
      }
      return zscaleLimits(e.f.sorted);
    });
  }, [
    frames,
    wiseFrames,
    view.wiseBrightness,
    view.wiseContrast,
    view.sxScaleMode,
    view.sxBlackPct,
    view.sxWhitePct,
  ]);

  // Sky->screen transform per frame (fixed shared sky frame).
  const transforms = useMemo(
    () =>
      frames.map((e) => {
        const basis = eastNorthBasis(e.f.wcs, target.ra, target.dec);
        return basis ? frameTransform(basis, displaySize, fov) : null;
      }),
    [frames, target.ra, target.dec, displaySize, fov],
  );

  useEffect(() => {
    setIndex(0);
    setPlaying(true);
  }, [frames]);

  useEffect(() => {
    if (!playing || frames.length < 2) return undefined;
    const t = setInterval(() => setIndex((i) => (i + 1) % frames.length), speedMs);
    return () => clearInterval(t);
  }, [playing, frames, speedMs]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || frames.length === 0) return;
    const i = Math.min(index, frames.length - 1);
    const entry = frames[i];
    const tf = transforms[i];
    const [vmin, vmax] = limits[i];
    const isWise = entry.mission === 'WISE';
    const invert = isWise ? view.wiseInvert : view.sxInvert;
    const stretch = isWise ? view.wiseStretch : view.sxStretch;
    const smooth = isWise ? view.wiseSmooth : view.sxSmooth;

    canvas.width = displaySize;
    canvas.height = displaySize;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = invert ? '#fff' : '#000';
    ctx.fillRect(0, 0, displaySize, displaySize);
    if (!tf) return;

    const off = renderOffscreen(
      { ...entry.f, vmin, vmax },
      {
        stretch,
        invert,
        whitePct: !isWise && view.sxScaleMode === 'percentile' ? view.sxWhitePct : undefined,
        blackPct: !isWise && view.sxScaleMode === 'percentile' ? view.sxBlackPct : undefined,
      },
    );
    ctx.save();
    ctx.imageSmoothingEnabled = Boolean(smooth);
    if (smooth) ctx.imageSmoothingQuality = 'high';
    ctx.setTransform(tf.a, tf.b, tf.c, tf.d, tf.e, tf.f);
    ctx.drawImage(off, 0, 0);
    ctx.restore();

    // Scale bar (bottom left): 30" or a round fraction of the FoV.
    const barArcsec = fov >= 400 ? 60 : fov >= 150 ? 30 : 10;
    const barPx = (barArcsec / fov) * displaySize;
    const fg = invert ? '#111' : '#eee';
    ctx.strokeStyle = fg;
    ctx.fillStyle = fg;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(14, displaySize - 16);
    ctx.lineTo(14 + barPx, displaySize - 16);
    ctx.stroke();
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${barArcsec}\u2033`, 14, displaySize - 22);

    // Orientation compass (top right): N up, E left.
    const ox = displaySize - 30;
    const oy = 34;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(ox, oy - 18);
    ctx.moveTo(ox, oy);
    ctx.lineTo(ox - 18, oy);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillText('N', ox, oy - 22);
    ctx.fillText('E', ox - 25, oy + 4);

    // Shared pin: same sky anchor as the other panels (fixed screen position
    // here, since the combined view is one rigid sky frame).
    if (pin) {
      const [px_, py_] = skyToScreen(pin.ra, pin.dec);
      if (px_ >= 0 && py_ >= 0 && px_ < displaySize && py_ < displaySize) {
        ctx.lineWidth = 1.8;
        ctx.strokeStyle = invert ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.6)';
        ctx.beginPath();
        ctx.arc(px_, py_, 8.5, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(41, 121, 255, 0.95)';
        ctx.beginPath();
        ctx.arc(px_, py_, 7, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.fillStyle = 'rgba(41, 121, 255, 0.95)';
        ctx.beginPath();
        ctx.arc(px_, py_, 2.2, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
  }, [frames, transforms, limits, index, displaySize, fov, view, pin]);

  if (frames.length === 0) return null;

  const i = Math.min(index, frames.length - 1);
  const entry = frames[i];
  const nWise = frames.filter((e) => e.mission === 'WISE').length;

  return (
    <section className="panel viewer combined-viewer">
      <h2>Combined timeline (WISE {'\u2192'} SPHEREx)</h2>
      <div className="frame-label">
        <span className={`mission-tag ${entry.mission === 'WISE' ? 'wise' : 'spherex'}`}>
          {entry.mission}
        </span>
        <span className="band">{entry.f.label}</span>
        <span className="datetime">{fmtDate(entry.f)}</span>
      </div>
      <canvas ref={canvasRef} onClick={onClick} />
      <div className="coord-readout">
        {`Shared sky frame: ${fov}\u2033 field \u00b7 north up, east left \u00b7 fixed ${(
          fov / displaySize
        ).toFixed(2)}\u2033/px \u00b7 each frame placed via its own WCS`}
      </div>
      <div className="controls">
        <button type="button" onClick={() => setPlaying((p) => !p)}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <button
          type="button"
          onClick={() => {
            setPlaying(false);
            setIndex((x) => (x - 1 + frames.length) % frames.length);
          }}
        >
          {'\u25c0'}
        </button>
        <button
          type="button"
          onClick={() => {
            setPlaying(false);
            setIndex((x) => (x + 1) % frames.length);
          }}
        >
          {'\u25b6'}
        </button>
        <input
          type="range"
          min="0"
          max={frames.length - 1}
          value={i}
          onChange={(e) => {
            setPlaying(false);
            setIndex(parseInt(e.target.value, 10));
          }}
        />
        <span className="frame-count">
          {i + 1}/{frames.length}
        </span>
      </div>
      <p className="combined-note">
        {`${nWise} WISE epochs (${fmtDate(frames[0].f)} \u2192 ${
          nWise ? fmtDate(frames[nWise - 1].f) : ''
        }) followed by ${frames.length - nWise} SPHEREx frames in chronological order \u2014 a high proper-motion source keeps moving in the same direction across the mission handoff.${
          skippedNoCoverage
            ? ` ${skippedNoCoverage} SPHEREx frame${skippedNoCoverage > 1 ? 's' : ''} without coverage at the target skipped.`
            : ''
        }`}
      </p>
    </section>
  );
}
