export const releaseValue = value => ['dr1', 'qr3', 'qr2'].includes(value) ? value : 'all';
export const releaseLabel = value => ({ dr1: 'DR1', qr3: 'QR3', qr2: 'QR2', 'dr1+qr3': 'DR1 + QR3' })[value] || 'Unknown release';

// Service results can include several releases. This is a result filter, not a
// promise that the remote photometry job itself was restricted to one release.
export function spectrumRelease(row) {
  const value = String(row.data_collection || '').trim().toLowerCase();
  if (['dr1', 'spherex_dr1', 'spherex_dr1_deep'].includes(value)) return 'dr1';
  if (['qr2', 'spherex_qr2', 'spherex_qr2_deep'].includes(value)) return 'qr2';
  if (['qr3', 'spherex_qr3', 'spherex_qr3_deep'].includes(value)) return 'qr3';
  return 'unknown';
}

export function hasQualityFlags(value) {
  if (value === null || value === undefined) return false;
  try {
    // BigInt preserves the photometry flags above bit 31. SOURCE and
    // FULLSAMPLE alone do not indicate a defective measurement.
    const flags = BigInt(value);
    return flags < 0n || (flags & ~((1n << 21n) | (1n << 12n))) !== 0n;
  } catch { return true; }
}
