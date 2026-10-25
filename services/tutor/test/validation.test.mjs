import test from 'node:test';import assert from 'node:assert/strict';
import {validateInput,validateLesson} from '../validation.mjs';
test('rejects invalid upload data and image spoofing',()=>{
 for(const v of [{},{image:'data:text/html;base64,AAAA'},{image:'data:image/png;base64,AAAA'},{text:'x'.repeat(1601)}])assert.throws(()=>validateInput(v));
});
test('lesson schema refuses executable graphics and limits paid narration segments',()=>{
 const l={meta:{title:'例题',problem:'解方程',answer:'四'},intro:[{show:'题目',say:'题目'}],scenes:[{title:'解题',beats:[{say:'先计算',do:[{write:'两边同时减去三'}]}]}]};
 assert.equal(validateLesson(l).scenes.length,1);
 assert.throws(()=>validateLesson({...l,figure:{type:'graph',curves:[{f:'globalThis.process.exit()'}]}}),/UNSUPPORTED_ANIMATION/);
 assert.throws(()=>validateLesson({...l,scenes:[{title:'解',beats:Array.from({length:12},()=>({say:'内容'}))}]}),/LESSON_TOO_LONG/);
 assert.throws(()=>validateLesson({...l,scenes:[{title:'解',beats:[{say:'内容',do:[{html:'<script>alert(1)</script>'}]}]}]}),/UNSUPPORTED_ANIMATION/);
});
