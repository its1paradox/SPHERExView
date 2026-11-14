export default function ReleaseSelect({ value = 'all', onChange, label = 'Data release', includeLegacy = false }) {
  return <label>{label}<select value={value} onChange={onChange}>
    <option value="all">{includeLegacy ? 'All returned releases' : 'DR1 + QR3'}</option>
    <option value="dr1">DR1</option>
    <option value="qr3">QR3</option>
    {(includeLegacy || value === 'qr2') && <option value="qr2" disabled={!includeLegacy}>
      {includeLegacy ? 'QR2 (legacy results)' : 'QR2 (search retired)'}
    </option>}
  </select></label>;
}
