export const sampleLesson={
 meta:{title:'一元一次方程',problem:'解方程：2x + 3 = 11',answer:'x = 4',style:'chalk'},
 intro:[{show:'解方程：$2x+3=11$',say:'解方程，二乘以未知数，加三，等于十一。'}],
 scenes:[
  {title:'第一步',goal:'两边同时减去 3',beats:[{say:'先把左边的三消掉。等式两边同时减去三，等式仍然成立。',do:[{write:'$2x+3-3=11-3$'},{write:'$2x=8$'}]}]},
  {title:'第二步',goal:'两边同时除以 2',beats:[{say:'现在二乘以未知数等于八。两边同时除以二，就得到未知数等于四。',do:[{write:'$2x=8$'},{write:'$x=4$'},{emph:'last'}]}]},
  {title:'第三步',goal:'代入原式验算',beats:[{say:'最后把四代入原来的方程。二乘以四加三，等于十一，所以答案正确。',do:[{write:'$2 \u00d7 4 + 3 = 11$'},{write:'答案：$x=4$'},{emph:'last'}]}]}
 ]
};
