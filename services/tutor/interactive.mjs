import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runProcess} from './render.mjs';
import {fail} from './validation.mjs';

const bridge=fileURLToPath(new URL('./interactive_bridge.py',import.meta.url));
const shared='Return one JSON object only. Never return code, HTML, JavaScript, URLs, expressions as strings, renderer data, or a precomputed answer. Use language "zh-CN" or "en", optional plain title. Scalars are finite numbers with absolute value <=1000, or {"op":"sqrt","arg":number}, or {"op":"ratio","num":integer,"den":positiveInteger}. For unsupported or ambiguous questions return {"unsupported":true}; do not replace the question with an example.';
const instructions={
  'solid-geometry':'Schema: {language,title?,body,dims,givens?,query}. body=cube dims={edge}; cuboid dims={lx,ly,lz}; regular_quad_pyramid dims={base_edge,height}; regular_tetrahedron dims={edge}. All dimensions positive. Vertices cube/cuboid A,B,C,D,A1,B1,C1,D1; pyramid O,A,B,C,D,P; tetrahedron A,B,C,D. givens <=12: {name,kind:"midpoint",of:[point,point]} or {name,kind:"ratio",of:[point,point],t:scalar between 0 and 1}. query: {type:"volume",pts?:[four points]} or {type:"line_plane_angle",line:[two points],plane:[three points]} (answer sine), {type:"line_line_angle",line1:[two points],line2:[two points]} (answer cosine), {type:"point_plane_distance",point,plane:[three points]}, or {type:"dihedral",edge:[two points],faces:[one point from each half-plane]} (signed cosine). No cylinders/cones or arbitrary coordinates.',
  'analytic-geometry':'Schema: {language,title?,conic,query}. conic: {kind:"ellipse",a,b,center?:[x,y]} or {kind:"circle",r,center?:[x,y]}; positive axes/radius. query: {type:"chord_length_range",through:[x,y]}, {type:"dot_product_range",through:[x,y],vertex:[x,y]}, {type:"triangle_area_range",through:[x,y],vertex:[x,y]}; through MUST lie strictly inside ellipse/circle. triangle_area_range additionally requires through to equal the curve center (central chords). Also ellipse {type:"slope_product_constant",point:[x,y]} with point exactly on ellipse; conic {kind:"parabola",p,axis?:"x"|"y",center?:[x,y]} supports {type:"parabola_dot_constant"} only for focus chord AB and dot product VA·VB based at the parabola vertex V. conic {kind:"hyperbola"} supports {type:"eccentricity_range",ratio:scalar>1}, meaning a point on right branch has PF1=ratio*PF2. This is a family question: omit fixed a,b,center,orient. No arbitrary hyperbola/parabola ranges, expression strings, or board fields.',
  'chem-reaction':'Schema: {language,title?,reactants:[{species,count?}],products:[{species,count?}],conditions?:{text?:plainText,reversible?:boolean,exothermic?:boolean,flame?:boolean,transitionGlow?:boolean}}. Species allowlist H2,O2,N2,Cl2,CO,CO2,H2O,CH4,NH3,Na,C,Fe,Mg,NaCl,Glucose. The service balances coefficients and maps atoms; omit count unless the original problem specifies it. Maximum 96 total atoms per side, 8 species per side. No atoms, bonds, atom_map, energy values, SMILES or mechanism guesses. One trusted mechanism is supported via {language,title?,mechanism:"esterification"}, exclusively ethanol + acetic acid -> ethyl acetate + water.',
};
export function interactiveInstructions(capability){
  if(!Object.hasOwn(instructions,capability))fail('INVALID_CAPABILITY');
  return `${shared}\n${instructions[capability]}`;
}

export async function buildInteractive(capability,spec,outDir,ctx,{sampleId,originalText}={}){
  ctx.guard();interactiveInstructions(capability);
  if(sampleId!==undefined&&!['default','random'].includes(sampleId))fail('INVALID_SAMPLE');
  let request;
  try {request=JSON.stringify({capability,spec,sampleId,originalText});}catch{fail('INVALID_INTERACTIVE_SPEC');}
  if(request.length>48000||originalText!==undefined&&(typeof originalText!=='string'||originalText.length>4000))fail('INVALID_INTERACTIVE_SPEC');
  fs.mkdirSync(outDir,{recursive:true});
  const requestFile=path.join(outDir,'.interactive-request.json');
  fs.writeFileSync(requestFile,request,{mode:0o600});
  let complete=false;
  try{
    ctx.guard();
    const signal=ctx.signal?AbortSignal.any([ctx.signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000);
    const output=await runProcess(process.env.PYTHON||'python3',['-B',bridge,requestFile,path.resolve(outDir)],{signal,maxBytes:100000});
    ctx.guard();
    let result;try{result=JSON.parse(output.toString());}catch{fail('INTERACTIVE_RENDER_FAILED');}
    if(result.error)fail(result.error);
    if(result.format!=='interactive'||!Array.isArray(result.steps)||result.steps.length>8)fail('INTERACTIVE_RENDER_FAILED');
    complete=true;return result;
  }finally{
    fs.rmSync(requestFile,{force:true});
    if(!complete){fs.rmSync(path.join(outDir,'preview.html'),{force:true});fs.rmSync(path.join(outDir,'lesson.json'),{force:true});}
  }
}
