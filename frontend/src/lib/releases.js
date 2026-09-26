export const releaseValue = value => ['qr2', 'qr3'].includes(value) ? value : 'all';
export const releaseLabel = value => value === 'qr2' ? 'QR2' : value === 'qr3' ? 'QR3' : 'Unknown release';

// Service results can include both releases. This is a result filter, not a
// promise that the remote photometry job itself was restricted to one release.
export function spectrumRelease(row) {
  const value = String(row.data_collection || '').trim().toLowerCase();
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
