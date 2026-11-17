/** Shared draft values for the always-visible toolbar and the settings dialog. */
export default function TargetFields({ form, setForm, coordsError, setCoordsError }) {
  const change = (key) => (event) => {
    const value = event.target.value;
    setForm(current => ({ ...current, [key]: value }));
    if (key === 'coords') setCoordsError(null);
  };
  return <>
    <label>
      RA, Dec · ICRS degrees
      <input aria-label="Target coordinates" value={form.coords} onChange={change('coords')}
        aria-invalid={Boolean(coordsError)} placeholder="133.786 -7.245" required />
    </label>
    <label>
      Field width (arcsec)
      <input aria-label="Field width (arcsec)" type="number" min="30" max="800" step="any"
        value={form.fov} onChange={change('fov')} required />
    </label>
  </>;
}
