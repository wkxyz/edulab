const BASE=import.meta.env.VITE_API_BASE||'';
const messages={NOT_CONFIGURED:'真实解题服务尚未开通，可先体验示例讲解。',STOPPED:'服务已暂停，请稍后再试。',QUEUE_FULL:'当前排队任务较多，请稍后再试。',OWNER_LIMIT:'今天的体验次数已用完。',PROJECT_LIMIT:'今天的生成额度已用完。',BUDGET_EXHAUSTED:'今天的服务额度已用完。',INVALID_IMAGE:'图片格式不正确，请重新选择。',IMAGE_TOO_LARGE:'图片不能超过4MB。',NOT_FOUND:'没有找到这条记录。',REVIEW_FAILED:'解答未通过复核，请重新拍摄完整题目。',INVALID_LESSON:'题目未能可靠识别或讲解，请重新拍摄。',GENERATION_FAILED:'生成失败，请稍后重试。',CANCELLED:'任务已取消。',TIMEOUT:'本次生成超时，请稍后重试。',EXPIRED:'任务已过期。'};
export const errorText=c=>messages[c]||'暂时无法完成，请稍后再试。';
let pending;
async function session(){let token=uni.getStorageSync('tutor-token');if(token)return token;if(!pending)pending=request('/api/session',{method:'POST',auth:false}).then(r=>{uni.setStorageSync('tutor-token',r.token);return r.token;}).finally(()=>{pending=null;});return pending;}
export async function request(url,{method='GET',data,auth=true,key}={}){
 const token=auth?await session():'';
 return new Promise((resolve,reject)=>uni.request({url:BASE+url,method,data,timeout:15000,header:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{}),...(key?{'idempotency-key':key}:{})},success(res){if(res.statusCode>=200&&res.statusCode<300)resolve(res.data);else {if(res.statusCode===401)uni.removeStorageSync('tutor-token');const e=new Error(errorText(res.data?.error));e.code=res.data?.error;reject(e);}},fail(){reject(new Error('连接失败，请检查网络后重试。'));}}));
}
export const mediaUrl=s=>s?BASE+s:'';
export const newKey=()=>Date.now().toString(36)+'_'+Math.random().toString(36).slice(2);
export async function createTask(data,key=newKey()){return request('/api/tasks',{method:'POST',data,key});}
export function chooseQuestion(){return new Promise((resolve,reject)=>uni.chooseImage({count:1,sourceType:['album','camera'],sizeType:['compressed'],success(res){const file=res.tempFiles[0];if(file.size>4194304)return reject(new Error('图片不能超过4MB。'));const p=res.tempFilePaths[0];
 // #ifdef MP-WEIXIN
 uni.getFileSystemManager().readFile({filePath:p,encoding:'base64',success(r){const ext=/\.png$/i.test(p)?'png':/\.webp$/i.test(p)?'webp':'jpeg';resolve({preview:p,image:'data:image/'+ext+';base64,'+r.data});},fail(){reject(new Error('图片读取失败。'));}});
 // #endif
 // #ifdef H5
 fetch(p).then(r=>r.blob()).then(blob=>new Promise((ok,bad)=>{const reader=new FileReader();reader.onload=()=>ok(reader.result);reader.onerror=bad;reader.readAsDataURL(blob);})).then(image=>resolve({preview:p,image})).catch(()=>reject(new Error('图片读取失败。')));
 // #endif
 },fail(e){if(!String(e.errMsg).includes('cancel'))reject(new Error('无法打开相机或相册，请检查授权。'));else resolve(null);}}));}
