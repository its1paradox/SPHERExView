import {useEffect,useState} from 'react';
export default function LocalSaveStatus() {
  const [saves,setSaves]=useState({});
  useEffect(()=>{const update=e=>setSaves(previous=>{const next={...previous};if(e.detail.done)delete next[e.detail.id];else next[e.detail.id]=e.detail;return next;});window.addEventListener('research-save',update);return()=>window.removeEventListener('research-save',update);},[]);
  const rows=Object.values(saves);
  return rows.length ? <aside className="local-save-status" role="status">{rows.map(row=><div key={row.id}>Saving results on this device · {row.saved}/{row.total} files</div>)}<small>Keep this tab open until saving finishes.</small></aside> : null;
}
