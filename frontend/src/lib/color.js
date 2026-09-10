// Display-only, two-channel comparison. All input science arrays remain signed
// and unmodified. Reference differences use formal independent-detector noise.
export const COLOR_METHOD = 'two-channel-common-gain-v1';
export const WARM = [1, 0.55, 0];
export const COOL = [0, 0.45, 1]; // WARM + COOL = neutral white.

export function pairSample(target, reference, index, options, sameDetector = false) {
  const a = target?.arrays, b = reference?.arrays;
  const k = sameDetector ? 1 : options.referenceGain;
  if (!a || !b || !(a.coverage[index] > 0) || !(b.coverage[index] > 0)) return null;
  const t = a.intensity[index], r = k * b.intensity[index];
  const vt = a.variance[index], vr = k * k * b.variance[index];
  if (![t, r, vt, vr].every(Number.isFinite) || vt < 0 || vr < 0) return null;
  // Self comparison shares all noise: its difference and variance are exactly 0.
  const difference = sameDetector ? 0 : t - r;
  const variance = sameDetector ? 0 : vt + vr;
  const z = variance > 0 ? difference / Math.sqrt(variance) : NaN;
  const tp = Math.max(t, 0), rp = Math.max(r, 0), sum = tp + rp;
  const contrast = sum > 0 ? (tp - rp) / sum : 0;
  const colored = !sameDetector && Number.isFinite(z) && Math.abs(z) >= options.colorSigma && sum > 0;
  return { target: t, reference: r, difference, variance, z,
    intensity: sum / 2, contrast, colored, sameDetector,
    targetNonpositive: t <= 0, referenceNonpositive: r <= 0 };
}

export function colorFrame(tile, reference, options, count) {
  const brightness = new Float64Array(count).fill(NaN);
  const contrast = new Float64Array(count), colored = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const sample = pairSample(tile, reference, i, options, tile.detector === reference?.detector);
    if (!sample) continue;
    brightness[i] = sample.intensity;
    contrast[i] = sample.contrast;
    colored[i] = sample.colored ? 1 : 0;
  }
  return { brightness, contrast, colored };
}

export function colorPixel(brightness, contrast, colored, white, stretch, strength = 1) {
  if (!Number.isFinite(brightness) || !(white > 0)) return null;
  // Common scalar gain preserves channel ratios through stretch and saturation.
  const q = stretch === 'linear' ? brightness / white : Math.asinh(10 * brightness / white) / Math.asinh(10);
  const c = colored ? Math.max(-1, Math.min(1, contrast)) * strength : 0;
  const t = 1 + c, r = 1 - c;
  const rgb = WARM.map((v, i) => v * t + COOL[i] * r);
  const gain = Math.max(0, q) / Math.max(1, Math.max(...rgb) * Math.max(0, q));
  return rgb.map(v => Math.round(255 * v * gain));
}

export function colorDescription(options) {
  return `Orange: target detector; blue: D${options.reference} × ${options.referenceGain}; neutral: equal or below ${options.colorSigma} formal σ. D${options.reference} is an unscaled self-reference control.`;
}
