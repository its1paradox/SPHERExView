// Wavelength-assigned false color, inspired by SPHEREx's first-light display.
// Hue describes CWAVE sampling, not a fitted source spectrum or temperature.
import { displayFraction } from './comparison.js';

export const WAVELENGTH_METHOD = 'cwave-mean-equal-luminance-v1';
export const WAVELENGTH_STOPS = [
  [0.75, [165, 75, 225]], [1.09, [91, 87, 221]],
  [1.62, [49, 192, 199]], [2.41, [81, 183, 72]],
  [3.82, [226, 205, 63]], [4.41, [235, 141, 47]], [5.0, [218, 65, 69]],
];
const Y = [0.2126, 0.7152, 0.0722];
export const srgbToLinear = x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
const linearToSrgb = x => x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
const stops = WAVELENGTH_STOPS.map(([lambda, rgb]) => [lambda, rgb.map(x => srgbToLinear(x / 255))]);

function chromaticity(lambda) {
  const value = Math.max(stops[0][0], Math.min(stops.at(-1)[0], lambda));
  const upper = stops.findIndex(([x]) => x >= value);
  const [lo, a] = stops[Math.max(0, upper - 1)], [hi, b] = stops[upper];
  const f = hi > lo ? (value - lo) / (hi - lo) : 0;
  const rgb = a.map((x, i) => x + (b[i] - x) * f);
  const luminance = rgb.reduce((sum, x, i) => sum + x * Y[i], 0);
  return rgb.map(x => x / luminance);
}

export function wavelengthFrame(tile, count) {
  const brightness = new Float64Array(count).fill(NaN);
  const wavelength = new Float64Array(count).fill(NaN);
  const a = tile?.arrays;
  for (let i = 0; a && i < count; i++) {
    if (!(a.coverage?.[i] > 0) || !Number.isFinite(a.intensity?.[i]) ||
        !Number.isFinite(a.wavelength?.[i]) || !(a.wavelength[i] > 0)) continue;
    brightness[i] = Math.max(0, a.intensity[i]); // display only; signed arrays untouched
    wavelength[i] = a.wavelength[i];
  }
  return { brightness, wavelength };
}

export function wavelengthPixel(brightness, lambda, white, stretch, strength = 1) {
  if (![brightness, lambda, white, strength].every(Number.isFinite) || lambda <= 0 || white <= 0) return null;
  const gray = displayFraction(Math.max(0, brightness), 0, white, stretch);
  const luminance = srgbToLinear(gray);
  if (luminance === 0) return [0, 0, 0];
  const hue = chromaticity(lambda);
  // Each wavelength has the same relative luminance as the corresponding gray
  // pixel. Desaturate highlights only as needed to fit the sRGB gamut: this
  // prevents channel clipping from creating false brightness differences.
  const gamut = (1 / luminance - 1) / Math.max(1e-12, Math.max(...hue) - 1);
  const saturation = Math.max(0, Math.min(1, strength, gamut));
  return hue.map(x => Math.round(255 * linearToSrgb(Math.max(0, Math.min(1, luminance * (1 + saturation * (x - 1)))))));
}

export const wavelengthDescription = 'Hue: coadd-weighted mean CWAVE wavelength (µm). Brightness: calibrated intensity on one shared scale. Hue shows wavelength sampling, not a measured source color or emission-line identification.';

export function wavelengthProvenance(display, white) {
  return {
    method: WAVELENGTH_METHOD, wavelength_map: 'wavelength',
    calibration: 'CWAVE; coadd-weighted mean of accepted input samples',
    wavelength_range_um: [0.75, 5], palette_stops_srgb8: WAVELENGTH_STOPS,
    outside_range: 'Endpoint hue; original calibrated wavelength retained in readouts and FITS',
    interpolation: 'Linear RGB, normalized to unit Rec.709 relative luminance',
    brightness: 'Shared intensity stretch; negative intensity clipped to zero for display only',
    highlights: 'Desaturate toward white at constant relative luminance to stay inside sRGB gamut',
    strength: display.wavelengthStrength, white_mjy_sr: white, stretch: display.stretch,
    legend: wavelengthDescription,
  };
}
