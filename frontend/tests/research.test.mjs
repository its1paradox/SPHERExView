import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { targetLink, formatBytes, targetSpec } from '../src/lib/research.js';

test('revisit preserves exact recipe, removes stale job ID, never leaks browser credentials', () => {
  const target = {ra:133.7599588, dec:-7.2449993, size:240, survey:'deep', release:'qr3',
    tools:{detectors:{hash:'#ra=133.7599588&dec=-7.2449993&size=240&survey=deep&release=qr3&weighting=ivar&result=old'}}};
  const detector = targetLink(target,'detectors');
  assert.match(detector, /^compare.html#/);
  assert.match(detector, /weighting=ivar/);
  assert.doesNotMatch(detector, /result=|research|key=/);
  assert.match(targetLink(target,'timeline'), /^timeline.html#ra=133.7599588/);
  assert.deepEqual(targetSpec({ra:'10',dec:'-5',radius_arcsec:'60'}),{ra:10,dec:-5,size:120,survey:'wide',release:'all'});
  assert.equal(formatBytes(1024**3),'1.0 GiB');
});

const compiled = build({entryPoints:['src/main.jsx'],bundle:true,format:'iife',jsx:'automatic',write:false,loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"'}});
const wait = async fn => { for(let i=0;i<100;i++) {if(fn()) return; await new Promise(r=>setTimeout(r,10));} assert.fail('Dashboard state did not settle'); };

test('landing library shows accurate storage, distinct tools, refresh choice and explicit deletion', async () => {
  const dom = new JSDOM('<div id="root"></div>',{url:'http://localhost/',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window, calls=[];
  w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
  w.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
  let row={id:'a'.repeat(32),ra:10,dec:-5,size:240,release:'all',survey:'wide',bytes:2048,visited_at:1700000000,busy:false,
    storage:{downloads:1024,responses:512,assets:256,comparisons:256,'job-index':0},tools:{timeline:{checked_at:1700000000}}};
  w.fetch=async (url,options)=>{
    calls.push([url,options]);
    if(options.method==='DELETE') {if(url.endsWith('/cache')) row={...row,bytes:0};else row=null;return {ok:true,json:async()=>({freed_bytes:2048})};}
    return {ok:true,json:async()=>({targets:row?[row]:[],bytes:row?.bytes||0})};
  };
  try {
    vm.runInContext((await compiled).outputFiles[0].text,dom.getInternalVMContext());
    await wait(()=>w.document.querySelector('.research-row'));
    assert.match(w.document.querySelector('h1').textContent,/research library/);
    assert.match(w.document.querySelector('.research-retention').textContent,/2.0 KiB/);
    assert.equal(w.document.querySelectorAll('.research-row .research-tool').length,2);
    assert.match(w.document.querySelector('.research-row .research-tool').href,/timeline.html#ra=10/);
    assert.match(w.document.querySelector('.research-badge').textContent,/Review for updates/);
    const key=w.localStorage.getItem('spherex.research.key.v1');
    assert.match(key,/^[a-f0-9]{64}$/);
    assert.equal(calls[0][1].headers['X-Research-Key'],key);
    const button = text => [...w.document.querySelectorAll('button')].find(b=>b.textContent===text);
    button('Refresh data').click();
    await wait(()=>w.document.querySelector('dialog[open]'));
    assert.equal(w.document.querySelectorAll('.research-refresh-tools button').length,2);
    assert.equal(calls.filter(([,o])=>o.method==='POST').length,0,'Opening the refresh dialog must not alter data');
    w.document.querySelector('[aria-label="Close dialog"]').click();
    await wait(()=>!w.document.querySelector('dialog[open]'));
    button('Manage storage').click();
    await wait(()=>w.document.querySelector('dialog[open]'));
    button('Clear 2.0 KiB of cache').click();
    await wait(()=>w.document.querySelector('.research-retention > strong')?.textContent === '0 B' && !w.document.querySelector('dialog[open]'));
    assert.ok(w.document.querySelector('.research-row'),'Clearing files retains the target');
    button('Manage storage').click();
    await wait(()=>w.document.querySelector('dialog[open]'));
    button('Remove target and data').click();
    await wait(()=>w.document.querySelector('.research-empty'));
    assert.match(w.document.querySelector('[role="status"]').textContent,/Target removed/);
    assert.equal(w.localStorage.getItem('spherex.research.key.v1'),key);
  } finally {w.close();}
});
