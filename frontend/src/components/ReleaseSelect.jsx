export default function ReleaseSelect({ value = 'all', onChange, label = 'Data release' }) {
  return <label>{label}<select value={value} onChange={onChange}>
    <option value="all">All available (QR2 + QR3)</option>
    <option value="qr2">QR2</option>
    <option value="qr3">QR3</option>
  </select></label>;
}
