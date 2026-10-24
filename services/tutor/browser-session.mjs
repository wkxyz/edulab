// Race the whole browser operation, including launch/readiness/screenshot, against cancellation.
export async function withBrowser(signal,launch,use){
 let browser,closePromise,rejectAbort;
 const close=()=>{
  if(!browser)return Promise.resolve();
  if(!closePromise)closePromise=(async()=>{
   let timer;try{await Promise.race([Promise.resolve().then(()=>browser.close()).catch(()=>{}),new Promise(r=>{timer=setTimeout(r,1000);})]);}finally{clearTimeout(timer);}
  })();
  return closePromise;
 };
 const aborted=new Promise((_,reject)=>{rejectAbort=reject;});
 const onAbort=()=>{void close();rejectAbort(signal.reason||new Error('CANCELLED'));};
 signal.addEventListener('abort',onAbort,{once:true});
 const work=Promise.resolve().then(()=>{if(signal.aborted)throw signal.reason||new Error('CANCELLED');return launch();}).then(value=>{
  browser=value;if(signal.aborted){void close();throw signal.reason||new Error('CANCELLED');}return use(browser);
 });
 if(signal.aborted)onAbort();
 try{return await Promise.race([work,aborted]);}finally{signal.removeEventListener('abort',onAbort);await close();}
}
