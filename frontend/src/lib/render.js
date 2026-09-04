// Client-side image rendering from raw float32 pixel arrays.
//
// The backend sends each frame as base64 little-endian float32 (display
// oriented, row 0 = top).  All stretch / contrast / zoom is done here so the
// AstroToolBox-style sliders react instantly without new HTTP requests.

export function decodeB64Float32(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) u8[i] = bin.charCodeAt(i);
  return new Float32Array(u8.buffer);
}

// vmin/vmax from percentiles of the (pre-sorted) pixel values.
export function percentileLimits(sorted, loPct, hiPct) {
  const n = sorted.length;
  if (n === 0) return [0, 1];
  const idx = (p) => sorted[Math.min(n - 1, Math.max(0, Math.round((p / 100) * (n - 1))))];
  const lo = idx(loPct);
  const hi = idx(hiPct);
  return hi > lo ? [lo, hi] : [lo, lo + 1e-6];
}

export function sortPixels(data) {
  return Float32Array.from(data).sort();
}

// IRAF/astropy-style zscale: fit a line to the sorted pixel values with
// iterative sigma rejection, then set the display range around the median
// with the fitted slope amplified by 1/contrast.  This is what the previous
// server-side rendering (astropy ZScaleInterval) used -- it hugs the sky
// background and keeps faint sources visible.
export function zscaleLimits(sorted, contrast = 0.25, maxIterations = 5, krej = 2.5) {
  const n = sorted.length;
  if (n === 0) return [0, 1];
  const zmin = sorted[0];
  const zmax = sorted[n - 1];
  const midIndex = (n - 1) / 2;
  const median = sorted[Math.floor(midIndex)];
  const minPix = Math.max(5, Math.floor(n * 0.5));

  const good = new Uint8Array(n).fill(1);
  let ngood = n;
  let lastNgood = n + 1;
  let slope = 0;
  let intercept = median;

  for (let iter = 0; iter < maxIterations && ngood >= minPix && ngood < lastNgood; iter += 1) {
    lastNgood = ngood;
    // least-squares fit y = intercept + slope * (x - midIndex) over good pixels
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < n; i += 1) {
      if (!good[i]) continue;
      const x = i - midIndex;
      sx += x;
      sy += sorted[i];
      sxx += x * x;
      sxy += x * sorted[i];
    }
    const det = ngood * sxx - sx * sx;
    if (det === 0) break;
    slope = (ngood * sxy - sx * sy) / det;
    intercept = (sy * sxx - sx * sxy) / det;
    // sigma-reject residuals
    let sumSq = 0;
    for (let i = 0; i < n; i += 1) {
      if (!good[i]) continue;
      const r = sorted[i] - (intercept + slope * (i - midIndex));
      sumSq += r * r;
    }
    const sigma = Math.sqrt(sumSq / ngood);
    const threshold = krej * sigma;
    ngood = 0;
    for (let i = 0; i < n; i += 1) {
      const r = sorted[i] - (intercept + slope * (i - midIndex));
      good[i] = Math.abs(r) <= threshold ? 1 : 0;
      ngood += good[i];
    }
  }

  let z1 = zmin;
  let z2 = zmax;
  if (ngood >= minPix && slope !== 0) {
    const zslope = slope / contrast;
    z1 = Math.max(zmin, median - midIndex * zslope);
    z2 = Math.min(zmax, median + (n - 1 - midIndex) * zslope);
  }
  return z2 > z1 ? [z1, z2] : [z1, z1 + 1e-6];
}

// AstroToolBox's exact contrast algorithm (ImageViewerTab.determineRefValues):
// limits are computed ONCE from the first frame of the stack and applied to
// every epoch, so the blink doesn't flicker.  brightness (1-100, default 1)
// raises the black point; contrast (1-100, default 50) sets the white point
// at  median + ((100 - contrast) / 10) * dev,  where dev is the spread
// between the ~0.5th and ~50th percentile of the pixel distribution.
export function astroToolboxLimits(sorted, brightness = 1, contrast = 50) {
  const n = sorted.length;
  if (n === 0) return [0, 1];
  const half = Math.floor(n / 2);
  const at = (i) => sorted[Math.min(n - 1, Math.max(0, i))];
  const lo = at(Math.floor((half * brightness) / 100));
  const min0 = at(Math.floor(half / 100));
  const max0 = at(n - 1 - Math.floor((half * 99) / 100));
  const dev = max0 - min0;
  const med = n % 2 ? sorted[(n - 1) / 2] : 0.5 * (sorted[n / 2 - 1] + sorted[n / 2]);
  const hi = med + ((100 - contrast) / 10) * dev;
  return hi > lo ? [lo, hi] : [lo, lo + 1e-6];
}

// Display pixel -> (RA, Dec) via the frame's linear TAN WCS (deg).
// (x, y) are image-space coordinates in DISPLAY orientation: (0, 0) is the
// top-left corner, pixel centers at (col + 0.5, row + 0.5).  The backend's
// arrays are vertically flipped relative to FITS, so un-flip the row first.
// Standard gnomonic (TAN) deprojection; validated against astropy to 1e-10".
export function pixelToWorld(wcs, x, y) {
  const D = Math.PI / 180;
  const X = x + 0.5;
  const Y = wcs.height - y + 0.5;
  const dx = X - wcs.crpix1;
  const dy = Y - wcs.crpix2;
  const xi = (wcs.cd11 * dx + wcs.cd12 * dy) * D;
  const eta = (wcs.cd21 * dx + wcs.cd22 * dy) * D;
  const a0 = wcs.crval1 * D;
  const d0 = wcs.crval2 * D;
  const den = Math.cos(d0) - eta * Math.sin(d0);
  const ra = (((a0 + Math.atan2(xi, den)) / D) % 360 + 360) % 360;
  const dec = Math.atan2(Math.sin(d0) + eta * Math.cos(d0), Math.hypot(xi, den)) / D;
  return [ra, dec];
}

// Inverse of pixelToWorld: sky (deg) -> display pixel coords.  Standard
// gnomonic (TAN) projection around crval, then the inverse CD matrix and
// the same FITS->display Y flip.  Returns [x, y] or null if the point is
// on the opposite hemisphere.
export function worldToPixel(wcs, ra, dec) {
  const D = Math.PI / 180;
  const a = ra * D;
  const d = dec * D;
  const a0 = wcs.crval1 * D;
  const d0 = wcs.crval2 * D;
  const cosc =
    Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a - a0);
  if (cosc <= 0) return null;
  const xi = (Math.cos(d) * Math.sin(a - a0)) / cosc / D;
  const eta =
    (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a - a0)) /
    cosc /
    D;
  const det = wcs.cd11 * wcs.cd22 - wcs.cd12 * wcs.cd21;
  const dx = (wcs.cd22 * xi - wcs.cd12 * eta) / det;
  const dy = (-wcs.cd21 * xi + wcs.cd11 * eta) / det;
  const X = dx + wcs.crpix1;
  const Y = dy + wcs.crpix2;
  return [X - 0.5, wcs.height - Y + 0.5];
}

const ASINH_A = 0.1;
const ASINH_NORM = Math.asinh(1 / ASINH_A);

const LOG_A = 1000;
const LOG_NORM = Math.log(1 + LOG_A);

function applyStretch(v, stretch) {
  if (stretch === 'asinh') return Math.asinh(v / ASINH_A) / ASINH_NORM;
  if (stretch === 'sqrt') return Math.sqrt(v);
  if (stretch === 'log') return Math.log(1 + LOG_A * v) / LOG_NORM;
  return v; // linear
}

// --- Lupton-style hue-preserving color rendering ------------------------
//
// For SPHEREx two-channel epoch coadds the frame carries `colorScale`:
//   { sigmaS, sigmaL,  // per-channel sky sigma (MJy/sr) of THIS epoch
//     W,               // frozen white point (MJy/sr), one per blink sequence
//     sat,             // high-S/N saturation boost (1.15 overview, 1.25 finder)
//     mode,            // 'color' | 'excess'
//     focusLong }      // excess mode: focus channel is the long-lambda one
//
// The backend sends each channel z-scored to its own sky noise; multiplying
// back by sigma restores calibrated, background-subtracted surface
// brightness, so color comes from the physical flux ratio with fixed unit
// gains (AB-flat neutrality) instead of noise-equalized display gains.
// One nonlinear transform is applied to the INTENSITY and all channels are
// scaled by the same multiplier (Lupton et al. 2004, PASP 116, 133), so hue
// never depends on brightness; chroma is gated by joint S/N (neutral gray
// below 2 sigma, full color by 5 sigma) so blank sky cannot mottle.
const LUPTON_Q = 10;
const LUPTON_ASINH_NORM = Math.asinh(LUPTON_Q);

function intensityTransform(x, W, stretch) {
  // x >= 0 in calibrated units; returns 0..1.  All stretch choices operate
  // on the shared intensity so every one of them is hue-preserving.
  const u = x / W;
  let v;
  if (stretch === 'linear') v = u;
  else if (stretch === 'sqrt') v = u > 0 ? Math.sqrt(u) : 0;
  else if (stretch === 'log') v = Math.log(1 + LOG_A * Math.max(u, 0)) / LOG_NORM;
  else v = Math.asinh(LUPTON_Q * Math.max(u, 0)) / LUPTON_ASINH_NORM; // asinh
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep01(t) {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

// Percentile of an ascending-sorted numeric array (pct in 0..100).
function sortedPct(sorted, pct) {
  if (!sorted || !sorted.length) return 0;
  const i = Math.round((pct / 100) * (sorted.length - 1));
  return sorted[Math.min(sorted.length - 1, Math.max(0, i))];
}

// Two-channel scientific color composite: short -> blue, long -> red,
// green = mean (the WiseView / unWISE W1-blue W2-red language, in which a
// long-only source is exactly (1, 0.5, 0) = orange).
//
// Inversion (light background) is HUE-PRESERVING: plain complement would
// flip orange to blue, so inverted pixels are complemented AND the R/B
// channels swapped (the AstroToolBox trick) -- sky becomes white, an
// orange source stays orange, a blue source stays blue.
//
// White/black points respond live to the display controls: when the
// colorScale carries the pooled positive-intensity distribution
// (posSorted + sigI), W and the black pedestal B are recomputed from the
// current whitePct/blackPct on every draw (W floored at 25 sigma_I so a
// starless field cannot over-stretch the sky).
function renderLupton(frame, { stretch, invert, whitePct, blackPct }, px) {
  const { data, data2, colorScale } = frame;
  const { sigmaS, sigmaL, sat = 1.25, mode = 'color', focusLong = true } = colorScale;
  const n = data.length;
  let W = colorScale.W;
  let B = 0;
  if (colorScale.posSorted && colorScale.posSorted.length) {
    W = Math.max(
      sortedPct(colorScale.posSorted, whitePct == null ? 99.5 : whitePct),
      25 * (colorScale.sigI || 0),
    );
    B = sortedPct(colorScale.posSorted, blackPct == null ? 0.5 : blackPct);
  }
  // Black pedestal in transformed units: t = (T(I)-T(B)) / (1-T(B)).
  const applyBlack = (t, TB) => {
    const v = (t - TB) / (1 - TB || 1);
    return v < 0 ? 0 : v > 1 ? 1 : v;
  };
  const putRGB = (o, R, G, B8) => {
    if (invert) {
      // complement + R/B swap: hue-preserving light background
      px[o] = 255 - Math.round(B8 * 255);
      px[o + 1] = 255 - Math.round(G * 255);
      px[o + 2] = 255 - Math.round(R * 255);
    } else {
      px[o] = Math.round(R * 255);
      px[o + 1] = Math.round(G * 255);
      px[o + 2] = Math.round(B8 * 255);
    }
    px[o + 3] = 255;
  };

  if (mode === 'excess') {
    // Grayscale reference field + single-hue overlay where the focus
    // channel is in significant EXCESS over the reference (the strongest
    // finder mode: reference-channel noise can never paint color).
    const sigmaE = Math.hypot(sigmaS, sigmaL);
    // Reference luminance scale follows the live white point when the
    // pooled intensity distribution is available (so the White point
    // control works in excess mode too); 40 sigma_ref otherwise.
    const WL = colorScale.posSorted ? W : 40 * (focusLong ? sigmaS : sigmaL);
    const WE = 20 * sigmaE; // excess stretch scale
    const TBL = intensityTransform(B, WL, stretch);
    const hue = focusLong ? [1, 0.5, 0] : [0, 0.5, 1];
    for (let i = 0; i < n; i += 1) {
      const XS = data[i] * sigmaS;
      const XL = data2[i] * sigmaL;
      const refFlux = focusLong ? XS : XL;
      const E = focusLong ? XL - XS : XS - XL; // unit gains, AB-flat neutral
      const zE = E / sigmaE;
      const a = smoothstep01((zE - 2.5) / 2.5); // onset 2.5 sigma, full 5 sigma
      const L = applyBlack(intensityTransform(Math.max(refFlux, 0), WL, stretch), TBL);
      const O = intensityTransform(Math.max(E, 0), WE, stretch);
      const vR = Math.min(1, (1 - a) * L + a * O * hue[0]);
      const vG = Math.min(1, (1 - a) * L + a * O * hue[1]);
      const vB = Math.min(1, (1 - a) * L + a * O * hue[2]);
      putRGB(i * 4, vR, vG, vB);
    }
    return;
  }

  const TB = intensityTransform(B, W, stretch);
  for (let i = 0; i < n; i += 1) {
    const zS = data[i];
    const zL = data2[i];
    const XS = Math.max(0, zS) * sigmaS;
    const XL = Math.max(0, zL) * sigmaL;
    const I = (XS + XL) / 2; // = (r+g+b)/3 with g=(r+b)/2
    let R = 0;
    let G = 0;
    let Bc = 0;
    if (I > 0) {
      const k = applyBlack(intensityTransform(I, W, stretch), TB) / I;
      R = k * XL;
      Bc = k * XS;
      G = 0.5 * (R + Bc);
      const mx = R > Bc ? R : Bc; // G is their mean, never the max
      if (mx > 1) {
        R /= mx;
        G /= mx;
        Bc /= mx;
      }
    }
    // Chroma gate: joint positive-source S/N (z units ARE flux/sigma).
    const S = Math.hypot(Math.max(0, zS), Math.max(0, zL));
    const s = sat * smoothstep01((S - 2) / 3);
    const V = R > G ? (R > Bc ? R : Bc) : G > Bc ? G : Bc;
    R = Math.max(0, V - s * (V - R));
    G = Math.max(0, V - s * (V - G));
    Bc = Math.max(0, V - s * (V - Bc));
    putRGB(i * 4, R, G, Bc);
  }
}

// Draw one frame onto `canvas`.
// frame: { data: Float32Array, data2?: Float32Array, width, height,
//          vmin, vmax, colorScale?, markers? }
// opts:  { scale, canvasW, canvasH, stretch, invert, smooth, showMarkers }
//
// When `data2` is present the frame is an AstroToolBox-style W1+W2 color
// composite (createColorImage): W1 -> red, W2 -> blue, green = average,
// both channels through the SAME stretch/limits.  In inverted mode (light
// background, the ATB default) channels are (r=W1, b=W2); in dark mode ATB
// swaps them (r=W2, b=W1) -- replicated exactly.
// Render a frame's float32 data to an offscreen canvas at native resolution
// (stretch + contrast limits + optional grayscale inversion applied).
// Shared by the per-mission viewers and the combined WISE→SPHEREx timeline.
export function renderOffscreen(frame, { stretch, invert, whitePct, blackPct }, off = null) {
  const { data, data2, width: w, height: h, vmin, vmax } = frame;
  const target = off || document.createElement('canvas');
  target.width = w;
  target.height = h;
  const octx = target.getContext('2d');
  const img = octx.createImageData(w, h);
  const px = img.data;
  if (data2 && frame.colorScale) {
    renderLupton(frame, { stretch, invert, whitePct, blackPct }, px);
    octx.putImageData(img, 0, 0);
    return target;
  }
  const range = vmax - vmin;
  const proc = (raw) => {
    let v = (raw - vmin) / range;
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    v = applyStretch(v, stretch);
    let g = Math.round(v * 255);
    if (invert) g = 255 - g;
    return g;
  };
  for (let i = 0; i < data.length; i += 1) {
    const o = i * 4;
    if (data2) {
      const p1 = proc(data[i]);
      const p2 = proc(data2[i]);
      px[o] = invert ? p1 : p2;
      px[o + 1] = Math.round((p1 + p2) / 2);
      px[o + 2] = invert ? p2 : p1;
    } else {
      const g = proc(data[i]);
      px[o] = g;
      px[o + 1] = g;
      px[o + 2] = g;
    }
    px[o + 3] = 255;
  }
  octx.putImageData(img, 0, 0);
  return target;
}

export function drawFrame(canvas, frame, opts) {
  const { width: w, height: h } = frame;
  const { scale, canvasW, canvasH, stretch, invert, smooth, showMarkers, whitePct, blackPct } =
    opts;

  if (canvas.width !== canvasW) canvas.width = canvasW;
  if (canvas.height !== canvasH) canvas.height = canvasH;

  // Render at native resolution on an offscreen canvas.
  if (!drawFrame._off) drawFrame._off = document.createElement('canvas');
  const off = renderOffscreen(frame, { stretch, invert, whitePct, blackPct }, drawFrame._off);

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = invert ? '#fff' : '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = Boolean(smooth);
  if (smooth) ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(off, 0, 0, w * scale, h * scale);

  if (showMarkers && frame.markers && frame.markers.length) {
    ctx.strokeStyle = 'rgba(255, 165, 0, 0.9)';
    ctx.lineWidth = 1.5;
    for (const m of frame.markers) {
      const r = Math.max(3, 12 - (m.gmag - 9) * 0.75);
      ctx.beginPath();
      ctx.arc(m.x * scale, m.y * scale, r, 0, 2 * Math.PI);
      ctx.stroke();
    }
  }

  // Dropped pin: fixed sky position, marked on every epoch.
  if (opts.pin) {
    const px_ = opts.pin.x * scale;
    const py_ = opts.pin.y * scale;
    ctx.lineWidth = 1.8;
    // contrasting halo so the pin reads on both light and dark backgrounds
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

  // Synced crosshair: the sky position hovered on the OTHER panel.
  if (opts.crosshair) {
    const cx = opts.crosshair.x * scale;
    const cy = opts.crosshair.y * scale;
    ctx.strokeStyle = 'rgba(255, 45, 85, 0.95)';
    ctx.lineWidth = 1.6;
    const gap = 4;
    const arm = 13;
    ctx.beginPath();
    ctx.moveTo(cx - arm, cy); ctx.lineTo(cx - gap, cy);
    ctx.moveTo(cx + gap, cy); ctx.lineTo(cx + arm, cy);
    ctx.moveTo(cx, cy - arm); ctx.lineTo(cx, cy - gap);
    ctx.moveTo(cx, cy + gap); ctx.lineTo(cx, cy + arm);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, gap, 0, 2 * Math.PI);
    ctx.stroke();
  }
}
