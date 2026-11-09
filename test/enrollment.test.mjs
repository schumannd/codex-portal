import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../src/store.mjs';
function withStore(fn){const dir=mkdtempSync(join(tmpdir(),'portal-test-'));const store=openStore(dir);try{fn(store);}finally{store.db.close();rmSync(dir,{recursive:true,force:true});}}
const credential=id=>({id,publicKey:Uint8Array.of(1,2,3),counter:0,transports:['internal']});
test('only manually created accounts can receive codes',()=>withStore(s=>{
 assert.throws(()=>s.issue('stranger'),/does not exist/);
 s.createAccount('owner');assert.ok(s.enrollment(s.issue('owner').code));
 assert.equal(s.enrollment('000000'),undefined);
}));
test('codes are hashed, single-use, and cannot be rebound to another account',()=>withStore(s=>{
 const owner=s.createAccount('owner');const other=s.createAccount('other');const {code}=s.issue('owner');
 const e=s.enrollment(code);assert.notEqual(e.hash,code);
 assert.throws(()=>s.saveCredential(e.hash,other,credential('wrong')),/expired or already used/);
 assert.ok(s.enrollment(code));s.saveCredential(e.hash,owner,credential('key'));
 assert.equal(s.enrollment(code),undefined);
 assert.throws(()=>s.saveCredential(e.hash,owner,credential('replay')),/expired or already used/);
 assert.equal(s.get('SELECT account FROM keys WHERE id=?','key').account,owner);
}));
test('expired and superseded codes cannot enroll devices',()=>withStore(s=>{
 const owner=s.createAccount('owner');const first=s.issue('owner');const second=s.issue('owner');
 assert.equal(s.enrollment(first.code),undefined);const e=s.enrollment(second.code);
 s.run('UPDATE enrollments SET expires=? WHERE hash=?',Date.now()-1,e.hash);
 assert.equal(s.enrollment(second.code),undefined);
 assert.throws(()=>s.saveCredential(e.hash,owner,credential('expired')),/expired or already used/);
}));
test('failed credential insertion rolls back code consumption',()=>withStore(s=>{
 const owner=s.createAccount('owner');const a=s.issue('owner');const ea=s.enrollment(a.code);s.saveCredential(ea.hash,owner,credential('duplicate'));
 const b=s.issue('owner');const eb=s.enrollment(b.code);
 assert.throws(()=>s.saveCredential(eb.hash,owner,credential('duplicate')));
 assert.ok(s.enrollment(b.code));
}));
