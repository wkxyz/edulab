#!/usr/bin/env python3
"""Typed problem specifications -> unchanged EduLab kernels and trusted templates.

No model-generated source or symbolic expression strings are evaluated. The only
renderer expressions are authored below or belong to upstream built-in examples.
"""
import html
import json
import math
from pathlib import Path
import random
import re
import sys

ROOT = Path(__file__).resolve().parents[2]
MAX_ATOMS = 96


class Invalid(Exception):
    pass


class Unsupported(Exception):
    pass


def obj(value, allowed, required=()):
    if not isinstance(value, dict) or set(value) - set(allowed) or not set(required) <= set(value):
        raise Invalid()
    return value


def text(value, limit=120):
    if not isinstance(value, str) or not value.strip() or len(value) > limit or '\x00' in value:
        raise Invalid()
    return value.strip()


def scalar(value, depth=0):
    if depth > 3 or isinstance(value, bool):
        raise Invalid()
    if isinstance(value, (int, float)):
        if not math.isfinite(value) or abs(value) > 1000:
            raise Invalid()
        return sp.Rational(str(value))
    obj(value, ('op', 'arg', 'num', 'den'), ('op',))
    if value['op'] == 'sqrt':
        obj(value, ('op', 'arg'), ('arg',))
        v = scalar(value['arg'], depth + 1)
        if v < 0:
            raise Invalid()
        return sp.sqrt(v)
    if value['op'] == 'ratio':
        obj(value, ('op', 'num', 'den'), ('num', 'den'))
        n, d = value['num'], value['den']
        if type(n) is not int or type(d) is not int or abs(n) > 10000 or not 1 <= d <= 10000:
            raise Invalid()
        v = sp.Rational(n, d)
        if abs(v) > 1000:
            raise Invalid()
        return v
    raise Invalid()


def coord(value):
    if not isinstance(value, list) or len(value) != 2:
        raise Invalid()
    return tuple(scalar(v) for v in value)


def positive(value):
    v = scalar(value)
    if not sp.Rational(1, 10000) <= v <= 1000:
        raise Invalid()
    return v


def name(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,15}', value):
        raise Invalid()
    return value


def refs(value, n, points):
    if not isinstance(value, list) or len(value) != n or len(set(value)) != n:
        raise Invalid()
    if any(name(x) not in points for x in value):
        raise Invalid()
    return [points[x] for x in value]


def finite(v):
    v = sp.simplify(v)
    if v.free_symbols or v.is_real is not True or not v.is_finite:
        raise Unsupported()
    return v


def tex(v):
    return sp.latex(finite(v))


def f(v):
    return float(sp.N(v))


def phrase(language, zh, en):
    return en if language == 'en' else zh


def step(title, description, **extra):
    return {'title': title, 'content': '<p>' + html.escape(description) + '</p>', **extra}


def solid(spec):
    import geometry_kernel as K
    import bodies
    obj(spec, ('skill', 'language', 'title', 'body', 'dims', 'givens', 'query'), ('body', 'dims', 'query'))
    lang = language(spec)
    body, d = spec['body'], spec['dims']
    if body == 'cube':
        obj(d, ('edge',), ('edge',)); a = positive(d['edge'])
        points, topo, volume = K.cube(a), bodies.cuboid(), a**3
    elif body == 'cuboid':
        obj(d, ('lx', 'ly', 'lz'), ('lx', 'ly', 'lz'))
        x, y, z = [positive(d[k]) for k in ('lx', 'ly', 'lz')]
        points, topo, volume = K.cuboid(x, y, z), bodies.cuboid(), K.volume_box(x, y, z)
    elif body == 'regular_quad_pyramid':
        obj(d, ('base_edge', 'height'), ('base_edge', 'height'))
        a, h = positive(d['base_edge']), positive(d['height'])
        points, topo, volume = K.regular_quad_pyramid(a, h), bodies.quad_pyramid(), K.volume_pyramid(a*a, h)
    elif body == 'regular_tetrahedron':
        obj(d, ('edge',), ('edge',)); a = positive(d['edge'])
        points, topo = K.regular_tetrahedron(a), bodies.tri_pyramid('D', ('A', 'B', 'C'))
        volume = K.volume_tetra(*[points[k] for k in ('A', 'B', 'C', 'D')])
    else:
        raise Unsupported()
    givens = spec.get('givens', [])
    if not isinstance(givens, list) or len(givens) > 12:
        raise Invalid()
    for given in givens:
        obj(given, ('name', 'kind', 'of', 't'), ('name', 'kind', 'of'))
        key = name(given['name'])
        if key in points:
            raise Invalid()
        p, q = refs(given['of'], 2, points)
        if given['kind'] == 'midpoint':
            if 't' in given: raise Invalid()
            points[key] = K.midpoint(p, q)
        elif given['kind'] == 'ratio':
            t = scalar(given.get('t'))
            if not 0 <= t <= 1: raise Invalid()
            points[key] = (1-t)*p+t*q
        else:
            raise Unsupported()
    query = obj(spec['query'], ('type', 'line', 'line1', 'line2', 'plane', 'point', 'edge', 'faces', 'pts'), ('type',))
    kind = query['type']; elements = {}; explanation = []
    fields={'line_plane_angle':('line','plane'),'line_line_angle':('line1','line2'),'point_plane_distance':('point','plane'),'dihedral':('edge','faces'),'volume':()}
    if kind not in fields: raise Unsupported()
    obj(query,('type',)+fields[kind]+(('pts',) if kind=='volume' else ()),('type',)+fields[kind])

    def line(field, key):
        p, q = refs(query.get(field), 2, points)
        if (q-p).norm() == 0: raise Invalid()
        elements[key] = {'type':'line', 'a':query[field][0], 'b':query[field][1], 'color':'emphasis'}
        return q-p

    def plane():
        p, q, r = refs(query.get('plane'), 3, points)
        n = K.normal_from_points(p, q, r)
        if n.norm() == 0: raise Invalid()
        elements['Plane'] = {'type':'plane', 'pts':query['plane']}
        return p, n

    if kind == 'line_plane_angle':
        v = line('line', 'Line'); p, n = plane()
        answer = K.line_plane_angle_sin(v, n)
        formula = r'\sin\theta=\frac{|v\cdot n|}{|v||n|}'
        explanation=[r'$v='+K.tex_vec(v)+r',\quad n='+K.tex_vec(K.simplify_vec(n))+'$',r'$|v\cdot n|='+tex(sp.Abs(v.dot(n)))+r',\quad |v|='+tex(v.norm())+r',\quad |n|='+tex(n.norm())+'$']
    elif kind == 'line_line_angle':
        v, w = line('line1', 'Line1'), line('line2', 'Line2')
        answer = K.line_line_angle_cos(v, w)
        formula = r'\cos\theta=\frac{|v\cdot w|}{|v||w|}'
        explanation=[r'$v='+K.tex_vec(v)+r',\quad w='+K.tex_vec(w)+'$',r'$|v\cdot w|='+tex(sp.Abs(v.dot(w)))+r',\quad |v|='+tex(v.norm())+r',\quad |w|='+tex(w.norm())+'$']
    elif kind == 'point_plane_distance':
        p, n = plane(); key = name(query.get('point'))
        if key not in points: raise Invalid()
        answer = K.point_plane_distance(points[key], p, n)
        formula = r'd=\frac{|(P-P_0)\cdot n|}{|n|}'
        explanation=[r'$P-P_0='+K.tex_vec(points[key]-p)+r',\quad n='+K.tex_vec(n)+'$',r'$|(P-P_0)\cdot n|='+tex(sp.Abs((points[key]-p).dot(n)))+r',\quad |n|='+tex(n.norm())+'$']
    elif kind == 'dihedral':
        a, b = refs(query.get('edge'), 2, points)
        c, face_d = refs(query.get('faces'), 2, points)
        if (b-a).norm() == 0 or K.normal_from_points(a,b,c).norm() == 0 or K.normal_from_points(a,b,face_d).norm() == 0:
            raise Invalid()
        answer = K.dihedral_cos(a,b,c,face_d)
        elements = {'Plane1':{'type':'plane','pts':query['edge']+[query['faces'][0]]}, 'Plane2':{'type':'plane','pts':query['edge']+[query['faces'][1]]}}
        formula = r'\cos\varphi=\frac{u_1\cdot u_2}{|u_1||u_2|}'
        u=b-a;w1=c-a;w2=face_d-a
        u1=w1-w1.dot(u)/u.dot(u)*u;u2=w2-w2.dot(u)/u.dot(u)*u
        explanation=[r'$u_1='+K.tex_vec(u1)+r',\quad u_2='+K.tex_vec(u2)+'$']
    elif kind == 'volume':
        answer = K.volume_tetra(*refs(query['pts'],4,points)) if 'pts' in query else volume
        formula = r'V=\frac{|(B-A)\times(C-A)\cdot(D-A)|}{6}' if 'pts' in query or body == 'regular_tetrahedron' else ('V=abh' if body in ('cube','cuboid') else r'V=\frac{S_{base}h}{3}')
    else:
        raise Unsupported()
    ans = tex(answer)
    magnitude = max(f(p.norm()) for p in points.values())
    scale = 3 / max(magnitude, 0.001)
    tp = K.to_three(points, scale=scale)
    center = [sum(v[i] for v in tp.values()) / len(tp) for i in range(3)]
    camera = [center[0]+6, center[1]+5, center[2]+7]
    elements['Axis'] = {'type':'axes','size':3.3}
    body_names={'cube':('正方体','Cube'),'cuboid':('长方体','Cuboid'),'regular_quad_pyramid':('正四棱锥','Regular square pyramid'),'regular_tetrahedron':('正四面体','Regular tetrahedron')}
    labels={'line_plane_angle':('线面角正弦','sine of the line-plane angle'),'line_line_angle':('两直线夹角余弦','cosine of the angle between the lines'),'point_plane_distance':('点到平面距离','point-plane distance'),'dihedral':('所指定两半平面的二面角余弦','signed cosine of the specified dihedral angle'),'volume':('体积','volume')}
    body_name=phrase(lang,*body_names[body]);query_label=phrase(lang,*labels[kind])
    dimension_text=', '.join(k+'='+tex(scalar(v)) for k,v in d.items())
    target_text=', '.join(k+'='+','.join(v) if isinstance(v,list) else k+'='+str(v) for k,v in query.items() if k!='type')
    generated=phrase(lang,f'{body_name}，${dimension_text}$；求{query_label}（{target_text}）。',f'{body_name}, ${dimension_text}$; find {query_label} ({target_text}).')
    title = text(spec.get('title', generated), 300)
    coords = ', '.join(k+'='+K.tex_vec(v) for k,v in points.items())
    steps = [step(phrase(lang,'建立坐标系','Set up coordinates'), '$'+coords+'$', highlight=['Axis']), step(phrase(lang,'计算向量与中间量','Compute vectors and intermediate values'),' '.join(explanation) if explanation else '$'+formula+'$',highlight=list(elements)),step(phrase(lang,'应用精确公式','Apply the exact formula'), '$'+formula+'$', highlight=list(elements)), step(phrase(lang,'得到精确答案','Obtain the exact answer'), '$'+ans+'$', highlight=list(elements))]
    for s in steps: s['cameraPos'] = dict(zip(('x','y','z'), camera))
    model = {'points':tp, 'mathPoints':{k:[f(x) for x in v] for k,v in points.items()},'scale':scale,'spheres':list(points),'edges':topo['edges'],'elements':elements,'target':center,'initialCamera':camera}
    return {'lesson':{'language':lang,'title':title,'meta':query_label,'answerLabel':query_label,'answerValue':'$'+ans+'$'},'steps':steps,'model':model}, generated, ans


def language(spec):
    lang = spec.get('language', 'zh-CN')
    if lang not in ('zh-CN', 'en'): raise Invalid()
    if 'skill' in spec and spec['skill'] not in ('edu-solid-geometry','edu-analytic-geometry','edu-chem-reaction'): raise Invalid()
    if 'title' in spec: text(spec['title'])
    return lang


def analytic(spec):
    import conics
    import analytic_kernel as K

    def chord_range(expr):
        # These chord quantities are quadratic rational functions of m. Refuse
        # a solver result unless all derivative roots have been classified.
        derivative=sp.Poly(sp.numer(sp.together(sp.diff(expr,K.m))),K.m)
        if not derivative.is_zero:
            roots=sp.roots(derivative,K.m)
            if sum(roots.values())!=derivative.degree() or any(r.is_real is None for r in roots): raise Unsupported()
        return K.range_over_m(expr)
    obj(spec, ('skill','language','title','conic','query'), ('conic','query'))
    lang = language(spec)
    q=obj(spec['query'],('type','through','vertex','point','ratio'),('type',)); query=q['type']
    fields={'dot_product_range':('through','vertex'),'chord_length_range':('through',),'triangle_area_range':('through','vertex'),'slope_product_constant':('point',),'parabola_dot_constant':(),'eccentricity_range':('ratio',)}
    if query not in fields: raise Unsupported()
    obj(q,('type',)+fields[query],('type',)+fields[query])
    c = obj(spec['conic'], ('kind','a','b','r','p','center','axis','orient'), ('kind',))
    center = coord(c.get('center',[0,0])); kind = c['kind']
    if kind == 'ellipse':
        obj(c,('kind','a','b','center'),('a','b'))
        a,b = positive(c.get('a')),positive(c.get('b'))
        if a == b: raise Invalid()
        curve = conics.ellipse(a,b,center)
    elif kind == 'circle':
        obj(c,('kind','r','center'),('r',))
        a=b=positive(c.get('r')); curve = conics.circle(center,a)
    elif kind == 'parabola':
        obj(c,('kind','p','axis','center'),('p',))
        p=scalar(c.get('p')); axis=c.get('axis','x')
        if p == 0 or axis not in ('x','y'): raise Invalid()
        curve=conics.parabola(p,center,axis)
    elif kind == 'hyperbola':
        if query!='eccentricity_range': raise Unsupported()
        obj(c,('kind',),('kind',))
        a,b=sp.Integer(1),sp.sqrt(3);orient='x'
        if orient not in ('x','y'): raise Invalid()
        curve=conics.hyperbola(a,b,center,orient)
    else: raise Unsupported()
    cb=dict(curve['board'],name='C',color='curve',label=curve['eq_latex'])
    extent=max(f(a),f(b)) if kind in ('ellipse','circle','hyperbola') else max(abs(f(p))*3,3)
    board={'view':{'xRange':[f(center[0])-extent*1.7,f(center[0])+extent*1.7], 'yRange':[f(center[1])-extent*1.4,f(center[1])+extent*1.4]},'conics':[cb],'points':{},'derived':[],'readouts':[]}
    details=[]
    if query in ('dot_product_range','chord_length_range','triangle_area_range'):
        if kind not in ('ellipse','circle'): raise Unsupported()
        through=coord(q.get('through'))
        inside=(through[0]-center[0])**2/a**2+(through[1]-center[1])**2/b**2
        if not inside < 1: raise Unsupported()
        board['points']['F']=[f(v) for v in through]
        board['param']={'name':'theta','label':r'$\theta$','min':0,'max':180,'step':0.5,'value':45,'standard':45,'unit':'°'}
        board['derived']=[{'type':'line_through_angle','name':'l','point':'F','angle':'@param','color':'line'},{'type':'intersect_line_conic','name':['A','B'],'line':'l','conic':'C','colors':['ptA','ptB']}]
        if query == 'chord_length_range':
            expr,cs=K.chord_len_sq_expr(curve,through); readout={'id':'target','label':'|AB|','type':'distance','a':'A','b':'B','highlight':True}
            rg=chord_range(expr); lo,hi=sp.sqrt(rg['lo']),sp.sqrt(rg['hi'])
        else:
            vertex=coord(q.get('vertex')); board['points']['M']=[f(v) for v in vertex]
            if query == 'dot_product_range':
                expr,cs=K.dot_product_expr(curve,through,vertex); rg=chord_range(expr);lo,hi=rg['lo'],rg['hi']
                board['derived'] += [{'type':'vector','name':'vMA','from':'M','to':'A','color':'vecA'},{'type':'vector','name':'vMB','from':'M','to':'B','color':'vecB'}]
                readout={'id':'target','label':r'$\vec{MA}\cdot\vec{MB}$','type':'dot','a':'vMA','b':'vMB','highlight':True}
            else:
                if through!=center: raise Unsupported()
                cs=K.chord_setup(curve,through)
                expr=sp.factor((cs['ysum']**2-4*cs['yprod'])*(vertex[0]-K.m*vertex[1]-cs['c'])**2/4)
                lo=sp.Integer(0);hi=sp.sqrt(a*a*(vertex[1]-center[1])**2+b*b*(vertex[0]-center[0])**2)
                board['derived'].append({'type':'polygon','name':'triangle','pts':['M','A','B'],'color':'area'})
                readout={'id':'target','label':'Area','type':'area_triangle','pts':['M','A','B'],'highlight':True}
        # Strict interior chords make this a continuous rational function on the
        # compact projective line. There are no excluded tangent/pole endpoints.
        ans=K.interval_latex(finite(lo),finite(hi),True,True)
        board['readouts']=[readout];board['rangeBar']={'of':'target','min':f(lo),'max':f(hi),'label':'$'+ans+'$'}
        details=[r'$x=my+c$', '$'+K.tex(cs['poly'].as_expr())+'=0$', '$'+K.tex(expr)+'$']
    elif query == 'slope_product_constant':
        if kind != 'ellipse': raise Unsupported()
        point=coord(q.get('point'))
        if sp.simplify(curve['implicit'].subs({conics.x:point[0],conics.y:point[1]})) != 0: raise Invalid()
        ans=tex(K.slope_product_central(curve,point))
        board['points']['P']=[f(v) for v in point]
        board['param']={'name':'theta','label':r'$\theta$','min':0,'max':360,'step':0.5,'value':45,'standard':45,'unit':'°'}
        board['derived']=[{'type':'point_on_conic','name':'A','conic':'C','t':'@param'},{'type':'point_reflect','name':'B','of':'A','center':[f(v) for v in center]},{'type':'line_through_points','name':'PA','a':'P','b':'A'},{'type':'line_through_points','name':'PB','a':'P','b':'B'}]
        board['readouts']=[{'id':'target','label':'Slope product (where both slopes exist)','type':'slope_product','a':'PA','b':'PB'}];board['constant']={'of':'target','label':'$'+ans+'$'}
        details=[r'$A+B=2O$',r'$k_{PA}k_{PB}=-b^2/a^2$']
    elif query == 'parabola_dot_constant':
        if kind != 'parabola': raise Unsupported()
        focus=curve['focus']; vertex=center
        expr,cs=K.dot_product_expr(curve,focus,vertex);constant,value=K.is_constant_in_m(expr)
        if not constant: raise Unsupported()
        ans=tex(value);board['points']={'F':[f(v) for v in focus],'M':[f(v) for v in vertex]}
        board['param']={'name':'theta','label':r'$\theta$','min':1 if axis=='x' else 91,'max':179 if axis=='x' else 269,'step':0.5,'value':45 if axis=='x' else 135,'standard':45 if axis=='x' else 135,'unit':'°'}
        board['derived']=[{'type':'line_through_angle','name':'l','point':'F','angle':'@param'},{'type':'intersect_line_conic','name':['A','B'],'line':'l','conic':'C'},{'type':'vector','name':'vMA','from':'M','to':'A'},{'type':'vector','name':'vMB','from':'M','to':'B'}]
        board['readouts']=[{'id':'target','type':'dot','label':'MA·MB','a':'vMA','b':'vMB'}];board['constant']={'of':'target','label':'$'+ans+'$'};details=['$'+K.tex(expr)+'$']
    elif query == 'eccentricity_range':
        if kind!='hyperbola' or center!=(0,0) or c.get('orient','x')!='x': raise Unsupported()
        ratio=scalar(q.get('ratio'))
        if ratio<=1: raise Invalid()
        rg=K.ecc_range_focal_ratio(ratio);ans=rg['latex'];R=f(ratio);bound=f(rg['hi']);maximum=max(3,bound*1.2);value=min((1+bound)/2,2)
        # All expression strings here are adapter-authored from validated numbers.
        focal=2/(R-1)
        xp=f'{focal+1}/e'
        board['conics']=[{'name':'C','kind':'hyperbola','a':1,'b':'sqrt(e*e-1)','center':[0,0],'orient':'x','asymptotes':True,'color':'curve'}]
        board['points']={'F1':{'xy':['-e',0]},'F2':{'xy':['e',0]},'P':{'xy':[xp,f'sqrt((e*e-1)*(({xp})*({xp})-1))']}}
        board['param']={'name':'e','label':'e','min':1.001,'max':maximum,'step':0.005,'value':value,'standard':value}
        board['derived']=[{'type':'segment','name':'PF1','a':'P','b':'F1'},{'type':'segment','name':'PF2','a':'P','b':'F2'}]
        board['readouts']=[{'id':'status','label':'P exists on right branch','type':'status','expr':'e','op':'<=','rhs':bound,'okText':'✓','badText':'✗'}];board['answerBand']={'min':1,'max':maximum,'lo':1,'hi':bound,'label':'$e\\in'+ans+'$'};details=[r'$|PF_1|-|PF_2|=2a$',r'$e\le\frac{k+1}{k-1}$']
    else: raise Unsupported()
    equation=curve['eq_latex'] if query!='eccentricity_range' else r'\frac{x^2}{a^2}-\frac{y^2}{b^2}=1,\quad a,b>0'
    query_labels={'chord_length_range':('过指定内点的弦长范围','Chord lengths through the specified interior point'),'dot_product_range':('所指定向量数量积的范围','Range of the specified vector dot product'),'triangle_area_range':('所指定顶点与动弦所成三角形面积范围','Range of triangle areas with the specified vertex and chord'),'slope_product_constant':('过椭圆上定点的两条直线斜率之积','Product of slopes from a fixed ellipse point to antipodal points'),'parabola_dot_constant':('过焦点的弦两端到抛物线顶点的向量数量积','Dot product of vertex-based vectors to focal chord endpoints'),'eccentricity_range':('右支点满足指定焦距比时离心率范围','Eccentricity range for the specified right-branch focal-distance ratio')}
    query_label=phrase(lang,*query_labels[query])
    generated=f'${equation}$; {query_label}; '+', '.join(k+'='+str(v) for k,v in q.items() if k!='type')
    title=text(spec.get('title',phrase(lang,'解析几何精确解','Exact analytic geometry')),120)
    steps=[step(phrase(lang,'建立曲线与条件','Set up the curve and conditions'),'$'+equation+'$'),step(phrase(lang,'联立与化简','Intersect and simplify'),' '.join(details)),step(phrase(lang,'精确结论','Exact conclusion'),'$'+ans+'$')]
    return {'lesson':{'language':lang,'title':title,'problem':'<p>'+html.escape(generated)+'</p>','answerLabel':query_label,'answer':'$'+ans+'$'},'steps':steps,'board':board},generated,ans


def chemistry(spec):
    import reaction_kernel as K
    import molecules as M
    obj(spec,('skill','language','title','reactants','products','conditions','mechanism'),())
    lang=language(spec)
    if spec.get('mechanism'):
        if spec['mechanism']!='esterification' or 'reactants' in spec or 'products' in spec or 'conditions' in spec: raise Unsupported()
        import generate
        built=generate.build_esterification()
        if 'title' in spec: built['meta']['title']=text(spec['title'])
        data=K.assemble_data(built)
        return data, 'Acetic acid + ethanol ⇌ ethyl acetate + water; acid catalysis and heat.', data['meta']['equation']
    sides=[];supplied=[]
    for field in ('reactants','products'):
        side=spec.get(field)
        if not isinstance(side,list) or not 1<=len(side)<=8: raise Invalid()
        names=[];counts={}
        for entry in side:
            obj(entry,('species','count'),('species',)); species=entry['species']
            if not isinstance(species,str) or not M.has_species(species): raise Unsupported()
            if species in names: raise Invalid()
            names.append(species)
            if 'count' in entry:
                count=entry['count']
                if type(count) is not int or not 1<=count<=32: raise Invalid()
                counts[species]=count
        sides.append(names);supplied.append(counts)
    if set(sides[0])&set(sides[1]): raise Unsupported()
    try: rc,pc=K.balanced_coefficients(*sides)
    except (ValueError,KeyError): raise Unsupported()
    for names,coefs,known in zip(sides,(rc,pc),supplied):
        if any(type(c) is not int or not 1<=c<=32 for c in coefs): raise Unsupported()
        if any(known[s]!=c for s,c in zip(names,coefs) if s in known): raise Invalid()
        if sum(sum(M.atom_counts(s).values())*c for s,c in zip(names,coefs))>MAX_ATOMS: raise Invalid()
    conditions=obj(spec.get('conditions',{}),('text','reversible','exothermic','flame','transitionGlow'))
    for key,value in conditions.items():
        if key=='text':
            text(value,80)
            if re.search(r'[\\{}$<>]',value): raise Invalid()
        elif type(value) is not bool: raise Invalid()
    counts=[dict(zip(names,coefs)) for names,coefs in zip(sides,(rc,pc))]
    atom_refs=[]
    for names,coefs in zip(sides,(rc,pc)):
        by_element={}
        for species,count in zip(names,coefs):
            for k in range(1,count+1):
                for atom in M.get(species)['atoms']:
                    by_element.setdefault(atom['el'],[]).append(f'{species}#{k}.{atom["slot"]}')
        atom_refs.append(by_element)
    if set(atom_refs[0])!=set(atom_refs[1]) or any(len(atom_refs[0][el])!=len(atom_refs[1][el]) for el in atom_refs[0]): raise Invalid()
    amap=[[a,b] for el in atom_refs[0] for a,b in zip(atom_refs[0][el],atom_refs[1][el])]
    generated=' + '.join(f'{n} {s}' for s,n in counts[0].items())+' → '+' + '.join(f'{n} {s}' for s,n in counts[1].items())
    built={'meta':{'title':text(spec.get('title',generated)),'language':lang,'category':'inorganic','engine':'morph'},'conditions':conditions,'reactants':[{'species':s,'count':c} for s,c in counts[0].items()],'products':[{'species':s,'count':c} for s,c in counts[1].items()],'atom_map':amap,'steps':[
        {'title':phrase(lang,'反应物','Reactants'),'html':html.escape(generated.split(' → ')[0])},
        {'title':phrase(lang,'原子重组示意','Illustrative atom rearrangement'),'html':phrase(lang,'相同元素的原子一一对应，旧键与新键由分子拓扑计算。此插值展示原子守恒，不表示真实反应路径。','Atoms are paired by element; changed bonds come from molecular topology. This interpolation illustrates conservation, not a physical reaction pathway.')},
        {'title':phrase(lang,'产物与守恒','Products and conservation'),'html':html.escape(generated.split(' → ')[1])},
    ]}
    data=K.assemble_data(built)
    if len(data['atoms'])>MAX_ATOMS or len(data['bonds']['before'])+len(data['bonds']['after'])>256: raise Invalid()
    return data,generated,data['meta']['equation']


# The upstream analytic expression helper uses Function(). Replace only that
# helper in generated HTML, leaving vendored files unchanged. This arithmetic
# interpreter also handles trusted registry examples without executing source.
SAFE_EVAL = r'''    function evalExpr(expr, env){
        if(typeof expr!=='string') return expr;
        try {
            if(expr.length>1000) return NaN;
            const tokens=expr.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z_0-9]*|\*\*|[+\-*/^(),]/g)||[];
            if(tokens.join('')!==expr.replace(/\s/g,'')) return NaN;
            let i=0,depth=0;const scope=Object.assign(Object.create(null),MATHENV,env);
            function atom(){if(++depth>32)throw Error();let t=tokens[i++],v;
                if(t==='+'||t==='-'){v=(t==='-'?-1:1)*atom();}
                else if(t==='('){v=add();if(tokens[i++]!==')')throw Error();}
                else if(/^(?:\d|\.)/.test(t||'')){v=Number(t);}
                else if(t&&Object.hasOwn(scope,t)){
                    const item=scope[t];if(typeof item==='function'){
                        if(tokens[i++]!=='(')throw Error();const args=[];
                        if(tokens[i]!==')'){args.push(add());while(tokens[i]===','){i++;args.push(add());}}
                        if(tokens[i++]!==')'||args.length>8)throw Error();v=item(...args);
                    }else{if(typeof item!=='number')throw Error();v=item;}
                }else throw Error();depth--;return v;}
            function pow(){let v=atom();if(tokens[i]==='^'||tokens[i]==='**'){i++;v=Math.pow(v,pow());}return v;}
            function mul(){let v=pow();while(tokens[i]==='*'||tokens[i]==='/'){const op=tokens[i++],b=pow();v=op==='*'?v*b:v/b;}return v;}
            function add(){let v=mul();while(tokens[i]==='+'||tokens[i]==='-'){const op=tokens[i++],b=mul();v=op==='+'?v+b:v-b;}return v;}
            const value=add();return i===tokens.length&&typeof value==='number'?value:NaN;
        }catch{return NaN;}
    }
'''


def plain(value):
    return html.unescape(re.sub('<[^>]*>',' ',value)).strip()


def main():
    request_file,out=Path(sys.argv[1]),Path(sys.argv[2])
    if request_file.stat().st_size>48000: raise Invalid()
    request=json.loads(request_file.read_text(),parse_constant=lambda _: (_ for _ in ()).throw(Invalid()))
    cap=request['capability']
    dirs={'solid-geometry':'edu-solid-geometry','analytic-geometry':'edu-analytic-geometry','chem-reaction':'edu-chem-reaction'}
    if cap not in dirs: raise Invalid()
    skill=ROOT/'skills'/dirs[cap]
    sys.path[:0]=[str(skill/'lib'),str(skill/'scripts')]
    global sp
    import sympy as sp
    import generate
    sample=request.get('sampleId')
    if sample:
        if sample not in ('default','random'): raise Invalid()
        if cap=='solid-geometry': data=generate.build_random_data(random.SystemRandom().randrange(1000000)) if sample=='random' else generate.build_data()
        elif cap=='analytic-geometry': data=(random.SystemRandom().choice(list(generate.REGISTRY.values())) if sample=='random' else generate.build_ellipse_dot_range)()
        else:
            import reaction_kernel
            data=reaction_kernel.assemble_data((random.SystemRandom().choice(list(generate.REGISTRY.values())) if sample=='random' else generate.build_combustion_ch4)())
        data.pop('_answer',None)
        meta=data.get('lesson',data.get('meta',{}));answer=meta.get('answerValue',meta.get('answer',meta.get('equation',''))).strip('$')
        problem=plain(meta.get('problem',meta.get('title','')))
    else:
        spec=request.get('spec')
        if not isinstance(spec,dict): raise Invalid()
        if spec.get('unsupported') is True: raise Unsupported()
        data,problem,answer={'solid-geometry':solid,'analytic-geometry':analytic,'chem-reaction':chemistry}[cap](spec)
    meta=data.get('lesson',data.get('meta',{}))
    if len(data.get('steps',[]))>8: raise Invalid()
    original=request.get('originalText')
    if original is not None:
        if not isinstance(original,str) or len(original)>4000: raise Invalid()
        problem=original
    result={'format':'interactive','title':meta.get('title',''),'problem':problem,'answer':answer,'steps':[{'title':s['title'],'description':plain(s.get('content',s.get('html','')))} for s in data['steps']]}
    template=generate.TEMPLATE.read_text(encoding='utf8')
    payload=json.dumps(data,ensure_ascii=False,allow_nan=False).replace('<','\\u003c').replace('>','\\u003e').replace('&','\\u0026').replace('\u2028','\\u2028').replace('\u2029','\\u2029')
    rendered=template.replace(generate.PLACEHOLDER,payload)
    if cap=='analytic-geometry':
        start=rendered.index('    function evalExpr(expr, env){');end=rendered.index('    const resolveVal=',start)
        rendered=rendered[:start]+SAFE_EVAL+rendered[end:]
        rendered=rendered.replace('window.onload=()=>{ buildConsole(); resizeCanvas(); };','window.onload=()=>{ buildConsole(); resizeCanvas(); requestAnimationFrame(()=>{window.EDULAB_INTERACTIVE_READY=true;}); };',1)
    elif cap=='solid-geometry':
        rendered=rendered.replace('        init();\n    </script>','        init();\n        Promise.resolve(globalThis.MathJax?.startup?.promise).then(()=>globalThis.MathJax?.typesetPromise?.()).then(()=>requestAnimationFrame(()=>{window.EDULAB_INTERACTIVE_READY=true;}));\n    </script>',1)
    else:
        rendered=rendered.replace('        };\n    })();','            requestAnimationFrame(()=>{window.EDULAB_INTERACTIVE_READY=true;});\n        };\n    })();',1)
    (out/'preview.html').write_text(rendered,encoding='utf8')
    (out/'lesson.json').write_text(json.dumps(dict(result,data=data),ensure_ascii=False,allow_nan=False),encoding='utf8')
    print(json.dumps(result,ensure_ascii=False,allow_nan=False))


if __name__=='__main__':
    try: main()
    except Unsupported: print(json.dumps({'error':'UNSUPPORTED_PROBLEM'}))
    except (Invalid,ValueError,KeyError,TypeError,IndexError,OverflowError,RecursionError): print(json.dumps({'error':'INVALID_INTERACTIVE_SPEC'}))
    except ImportError: print(json.dumps({'error':'INTERACTIVE_DEPENDENCY_MISSING'}))
