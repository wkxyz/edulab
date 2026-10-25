import test from 'node:test';import assert from 'node:assert/strict';
import {withBrowser} from '../browser-session.mjs';
test('cancelling a pending browser readiness wait releases the serial worker',async()=>{
 const controller=new AbortController();let closed=0,entered;
 const ready=new Promise(r=>{entered=r;});
 const work=withBrowser(controller.signal,async()=>({close:async()=>{closed++;}}),async()=>{entered();await new Promise(()=>{});});
 await ready;controller.abort(new Error('cancelled'));
 await assert.rejects(work,/cancelled/);assert.equal(closed,1);
});
test('a browser that launches after cancellation is still closed',async()=>{
 const controller=new AbortController();let launch,closed=0;
 const work=withBrowser(controller.signal,()=>new Promise(r=>{launch=r;}),()=>{throw new Error('must not run');});
 await new Promise(r=>setImmediate(r));controller.abort(new Error('cancelled'));await assert.rejects(work,/cancelled/);
 launch({close:async()=>{closed++;}});await new Promise(r=>setImmediate(r));assert.equal(closed,1);
});
