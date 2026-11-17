import { IDBFactory } from 'fake-indexeddb';
import { webcrypto } from 'node:crypto';
export function localWindow(w, db = new IDBFactory()) {
  w.indexedDB=db; w.structuredClone=structuredClone;w.Headers=Headers;w.Response=Response;w.TextEncoder=TextEncoder;w.TextDecoder=TextDecoder;
  Object.defineProperty(w,'crypto',{value:webcrypto,configurable:true});
  return db;
}
