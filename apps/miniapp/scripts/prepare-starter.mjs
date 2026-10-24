// Reproducible vendor import: user-facing sources live in app/, generated src/ is disposable.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const SHA='cb20444d56294261d2f8ae6fd8d97beed67f108d';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'edulab-starter-'));
try{
 execFileSync('git',['clone','--depth','1','--branch','v2','https://github.com/dcloudio/uni-starter.git',path.join(temp,'starter')],{stdio:'inherit'});
 const source=path.join(temp,'starter');const actual=execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim();
 if(actual!==SHA){execFileSync('git',['fetch','--depth','1','origin',SHA],{cwd:source,stdio:'inherit'});execFileSync('git',['checkout','--detach',SHA],{cwd:source,stdio:'inherit'});}
 fs.rmSync(path.join(root,'src'),{recursive:true,force:true});fs.mkdirSync(path.join(root,'src'),{recursive:true});
 for(const name of ['uni_modules','common','lang','static','uni.scss'])fs.cpSync(path.join(source,name),path.join(root,'src',name),{recursive:true});
 fs.copyFileSync(path.join(source,'LICENSE'),path.join(root,'UNI-STARTER-LICENSE'));
 fs.cpSync(path.join(root,'app'),path.join(root,'src'),{recursive:true});
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'src/manifest.json')));
 if(process.env.WECHAT_APP_ID)manifest['mp-weixin'].appid=process.env.WECHAT_APP_ID;
 fs.writeFileSync(path.join(root,'src/manifest.json'),JSON.stringify(manifest,null,2));
 console.log('uni-starter source pinned:',SHA,'; local app overlay applied. No cloud services deployed.');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
