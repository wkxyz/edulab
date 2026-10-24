// Built-in examples use deterministic numbers and repository-owned visual data.
export function animationSample(capability){
 if(capability==='physics-video')return {
  meta:{title:'牛顿第二定律与位移',problem:'质量2千克的物体受到6牛的水平合力，从静止运动2秒，求加速度和位移。',answer:'a = 3 m/s²，s = 6 m'},
  scenes:[{title:'从合力到运动',lines:[
   {zh:'质量二千克的物体，受到六牛的水平合力，从静止开始运动。',tts:'质量二千克的物体，受到六牛的水平合力，从静止开始运动。',en:'A two-kilogram object starts from rest under a six-newton force.'},
   {zh:'根据牛顿第二定律，加速度等于合力除以质量，得到每二次方秒三米。',tts:'根据牛顿第二定律，加速度等于合力除以质量，得到每二次方秒三米。',en:'Newton’s second law gives an acceleration of three metres per second squared.'},
   {zh:'二秒内的位移，等于二分之一乘加速度再乘时间的平方，所以位移是六米。',tts:'二秒内的位移，等于二分之一乘加速度再乘时间的平方，所以位移是六米。',en:'The displacement after two seconds is six metres.'}
  ],objects:[
   {id:'floor',kind:'ground',points:[[100,630],[850,630]],color:'gray'},
   {id:'body',kind:'ball',at:[180,600],radius:24,color:'blue',label:'m'},
   {id:'force',kind:'force',at:[180,600],body:'body',vector:[150,0],color:'red',label:'F = 6 N'}
  ],actions:[{kind:'reveal',target:'force',line:0},{kind:'move',target:'body',line:2,motion:{kind:'constantAcceleration',duration:2,scale:80,velocity:[0,0],acceleration:[3,0]}}],
  board:[{text:'m = 2 kg，F = 6 N',line:0},{text:'a = F/m = 3 m/s²',line:1},{text:'s = ½at² = 6 m',line:2}]}]
 };
 if(capability==='chem-video')return {
  meta:{title:'甲烷燃烧与原子守恒',problem:'配平 CH4 + O2 → CO2 + H2O，并说明反应前后各元素的原子如何守恒。',answer:'CH₄ + 2O₂ → CO₂ + 2H₂O'},
  scenes:[{title:'按原子守恒配平',lines:[
   {zh:'甲烷在氧气中燃烧，生成二氧化碳和水。配平时，化学式本身不能改变。',tts:'甲烷在氧气中燃烧，生成二氧化碳和水。配平时，化学式本身不能改变。',en:'Methane burns in oxygen to produce carbon dioxide and water.'},
   {zh:'先配碳和氢。一个甲烷分子含一个碳原子和四个氢原子，对应一个二氧化碳分子和两个水分子。',tts:'先配碳和氢。一个甲烷分子含一个碳原子和四个氢原子，对应一个二氧化碳分子和两个水分子。',en:'Balance carbon first, then hydrogen.'},
   {zh:'产物一侧共有四个氧原子，所以需要两个氧气分子。反应前后，三种元素的原子总数都相等。',tts:'产物一侧共有四个氧原子，所以需要两个氧气分子。反应前后，三种元素的原子总数都相等。',en:'Two oxygen molecules supply the four oxygen atoms; every element is conserved.'}
  ],objects:[
   {id:'eq',kind:'equation',l:['CH4','O2'],r:['CO2','H2O'],coefficients:[1,2,1,2],above:'点燃'},
   {id:'particles',kind:'particles',equation:'eq',rect:[110,400,850,780],initial:[3,6,0,0],extent:3,radius:13}
  ],actions:[{kind:'react',target:'particles',line:2}],
  board:[{text:'配平只改变系数，不改化学式',line:0},{text:'C：1 = 1',line:1},{text:'H：4 = 2 × 2',line:1,fraction:0.4},{text:'O：2 × 2 = 2 + 2',line:2},{text:'系数：1 : 2 : 1 : 2',line:2,fraction:0.7}]}]
 };
 return {
  meta:{title:'一元一次方程·手绘讲解',problem:'解方程：2x + 3 = 11',answer:'x = 4'},
  scenes:[{title:'用图像理解方程',lines:[
   {zh:'解方程，二乘以未知数，加三，等于十一。蓝线表示二乘以未知数再加三。',tts:'解方程，二乘以未知数，加三，等于十一。蓝线表示二乘以未知数再加三。',en:'Solve two x plus three equals eleven.'},
   {zh:'等式两边同时减去三，再同时除以二，就得到未知数等于四。',tts:'等式两边同时减去三，再同时除以二，就得到未知数等于四。',en:'Subtract three, then divide by two: x equals four.'},
   {zh:'红色水平线表示十一。两条线交点的横坐标为四，代入原式，答案也正确。',tts:'红色水平线表示十一。两条线交点的横坐标为四，代入原式，答案也正确。',en:'The intersection is at x equals four, which also checks in the original equation.'}
  ],objects:[
   {id:'graph',kind:'graph',at:[130,180],width:650,height:550,xRange:[0,6],yRange:[0,15],points:[[0,3],[1,5],[2,7],[3,9],[4,11],[5,13],[6,15]],xLabel:'x',yLabel:'y',color:'blue'},
   {id:'level',kind:'polyline',points:[[130,326.667],[780,326.667]],color:'red',label:'y = 11'},
   {id:'point',kind:'point',at:[130,620],radius:10,color:'red',label:'P'}
  ],actions:[{kind:'reveal',target:'level',line:1},{kind:'move',target:'point',line:2,motion:{kind:'constantAcceleration',duration:2,scale:1,velocity:[216.666667,-146.666667],acceleration:[0,0]}}],
  board:[{text:'2x + 3 = 11',line:0},{text:'2x = 8',line:1},{text:'x = 4',line:1,fraction:0.6},{text:'2 × 4 + 3 = 11',line:2}]}]
 };
}
