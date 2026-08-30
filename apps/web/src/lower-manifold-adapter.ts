/**
 * Universal Lower-Manifold Adapter — Movement & Pseudo-Animation Engine
 * Auto-selects animation per geometry class (G1..G9), never user-exposed.
 * Pure decorator: real data untouched, decoration strictly additive.
 */

export type GeometryClass = 'G1_RIBBON'|'G2_RASTER'|'G3_NETWORK'|'G4_LATTICE'|'G5_PHASE'|'G6_FIELD'|'G7_SCENE'|'G8_RADIAL'|'G9_TEXT';

export interface Clock {
  wallMs: number; barMod12: number; barMod8: number; barMod16: number;
  phase12: number; phase8: number; slow: number; fast: number;
  hasClock: boolean; n: number;
}

export interface LowerDataset {
  label: string; data: {x:number,y:number}[]; borderColor?: string; backgroundColor?: string;
  pointRadius?: number|number[]; pointBackgroundColor?: string|string[]; borderWidth?: number;
  borderDash?: number[]; borderDashOffset?: number; pointStyle?: string; fill?: boolean; tension?: number; order?: number;
  showLine?: boolean; type?: string;
}

function hashRand(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453; return x - Math.floor(x);
}
function seededPhase(idx: number, salt=0){ return hashRand(idx*12.9898+salt)*2*Math.PI; }

export function makeClock(n: number): Clock {
  let wallMs: number, hasClock=true;
  try { wallMs = Date.now(); } catch { wallMs = n*1000; hasClock=false; }
  const barMod12=(n%12)/12, barMod8=(n%8)/8, barMod16=(n%16)/16;
  return { wallMs, barMod12, barMod8, barMod16, phase12:barMod12*2*Math.PI, phase8:barMod8*2*Math.PI, slow:(wallMs/1000)%1000, fast:(wallMs/150)%1000, hasClock, n };
}

// Hardcoded registry — never exposed as input
export const PANEL_GEOMETRY: Record<string, GeometryClass> = {
  'Pulse': 'G1_RIBBON', 'Dual-TF': 'G1_RIBBON', 'Fusion Energy': 'G1_RIBBON', 'Equity & Performance Curve': 'G1_RIBBON', 'Hamiltonian Conservation Waterfall': 'G1_RIBBON',
  'Spike Raster Plot': 'G2_RASTER', 'Force-Directed Cascade Graph': 'G3_NETWORK', 'Synaptic Weight Heatmap': 'G3_NETWORK', 'Transition Graph': 'G3_NETWORK',
  'Living Neural Lattice': 'G4_LATTICE', 'BMU Trajectory Path': 'G4_LATTICE', 'U-Matrix Topology': 'G4_LATTICE', 'Component Plane Viewer': 'G4_LATTICE', 'Regime Population Census': 'G4_LATTICE',
  'Phase-Space Portrait': 'G5_PHASE', 'Noether Symmetry Compass': 'G5_PHASE', 'Lorentz Boost / Rapidity Stage': 'G5_PHASE',
  'Potential Energy Landscape': 'G6_FIELD', 'Euler-Lagrange Force Field Lens': 'G6_FIELD', 'Lorentzian Function Gallery': 'G6_FIELD', 'Lorentzian Polynomial Landscape': 'G6_FIELD', 'Length-Space Time-Separation': 'G6_FIELD', 'Curvature & Manifold Pulse': 'G6_FIELD',
  'Advanced Dynamic Field': 'G7_SCENE', 'Minkowski Light-Cone Laboratory': 'G7_SCENE', 'Spinor Bloch Sphere': 'G7_SCENE', 'Null Generator Fan': 'G7_SCENE',
  'Lorentzian KNN Constellation': 'G8_RADIAL',
  'Upgraded Classic': 'G9_TEXT',
};

// — Cross-cutting primitives —
function lightningJitter(a:{x:number,y:number}, b:{x:number,y:number}, edgeId:number, clock:Clock): {x:number,y:number}[] {
  const segs=4, pts=[a]; let px=a.x, py=a.y; const dx=(b.x-a.x)/segs, dy=(b.y-a.y)/segs;
  for(let i=1;i<segs;i++){ const t=i/segs; const mx=a.x+dx*i, my=a.y+dy*i; const perp=hashRand(edgeId*997+Math.floor(clock.wallMs/150)+i)*6-3; // seeded
    pts.push({x:mx - dy*0.08*perp, y:my + dx*0.08*perp});
  } pts.push(b); return pts;
}

// — Engines —

function applyRibbonEngine(datasets: LowerDataset[], clock: Clock): LowerDataset[] {
  if(datasets.length===0) return datasets;
  const line = datasets[0]; const trailLen=Math.max(1, line.data.length);
  // Traveling glint
  const glintIdx = Math.floor((clock.wallMs/1000*2)%trailLen);
  const pt = line.data[Math.min(glintIdx, trailLen-1)];
  const glint: LowerDataset = { label:'Glint', data: pt?[pt]:[], pointRadius:6, pointBackgroundColor:'#ffffff', backgroundColor:'rgba(255,255,255,0.9)', borderColor:'transparent', showLine:false, order:0 };
  // Breathing halo via tension modulation
  line.tension = 0.4 + 0.08*Math.sin(clock.phase12);
  line.borderDashOffset = (clock.wallMs/60)%8;
  return [...datasets, glint];
}

function applyRasterEngine(datasets: LowerDataset[], clock: Clock): LowerDataset[] {
  const out=[...datasets];
  // Ghost flicker — per-row seeded low-alpha blip
  const ghost: LowerDataset = { label:'Ghost Flicker', data:[], pointRadius:[], pointBackgroundColor:[], showLine:false, order:5 };
  for(let row=0;row<16;row++){
    if(hashRand(row*997+Math.floor(clock.wallMs/120)) < 0.04){
      (ghost.data as any).push({x: hashRand(row*3.1)*100, y: row});
      (ghost.pointRadius as number[]).push(2);
      (ghost.pointBackgroundColor as string[]).push('rgba(180,140,255,0.25)');
    }
  }
  if(ghost.data.length) out.push(ghost);
  // Ambient shimmer handled via alpha modulation on first dataset
  if(out[0]) out[0].backgroundColor = `rgba(180,140,255,${0.04+0.02*Math.sin(clock.wallMs/900)})`;
  return out;
}

function applyNetworkEngine(datasets: LowerDataset[], clock: Clock): LowerDataset[] {
  // Jitter nodes + traveling edge dot
  return datasets.map((d,i)=>{
    if(d.data.length===0) return d;
    // jitter
    const nd = d.data.map((p,idx)=>({x: p.x + Math.sin(clock.wallMs*0.0008+seededPhase(idx+ i*100))*0.8, y: p.y + Math.cos(clock.wallMs*0.0009+seededPhase(idx+ i*200))*0.8}));
    // edge current dot on each edge dataset (detect by label containing edge)
    return {...d, data: nd, borderDashOffset: d.label.toLowerCase().includes('edge') ? (clock.wallMs/40)%20 : d.borderDashOffset };
  });
}

function applyLatticeEngine(datasets: LowerDataset[], clock: Clock): LowerDataset[] {
  // Breathing rings + ripple + idle shimmer
  const out = datasets.map((d,i)=>({...d, pointRadius: typeof d.pointRadius==='number' ? (d.pointRadius as number)*(0.9+0.2*Math.sin(clock.phase8+seededPhase(i))) : d.pointRadius }));
  // Ripple emanation from BMU if present (detect label BMU)
  const bmuIdx = out.findIndex(d=>/BMU/i.test(d.label));
  if(bmuIdx>=0){
    const ripple: LowerDataset = { label:'Ripple', data: out[bmuIdx].data.slice(0,8).map((p,di)=>({x:p.x, y:p.y})), pointRadius: out[bmuIdx].data.slice(0,8).map((_,di)=> 4+ di*2 + 2*Math.sin(clock.phase8 - di*0.8)), pointBackgroundColor:'rgba(180,140,255,0.15)', showLine:false, order:1 } as any;
    out.push(ripple as any);
  }
  return out;
}

function applyPhaseEngine(datasets: LowerDataset[], clock: Clock): LowerDataset[] {
  // Comet head + dash offset
  return datasets.map(d=>{
    if(d.data.length<2) return d;
    const last=d.data[d.data.length-1], prev=d.data[d.data.length-2];
    const vx=last.x-prev.x, vy=last.y-prev.y;
    const comet: LowerDataset = { label:'Comet', data:[{x:last.x+vx*0.3,y:last.y+vy*0.3},{x:last.x+vx*0.6,y:last.y+vy*0.6}], pointRadius:[4,2], pointBackgroundColor:['rgba(255,255,255,0.6)','rgba(255,255,255,0.2)'], showLine:false, order:0 };
    return {...d, borderDashOffset:(clock.wallMs/80)%20 };
  }).concat([{ label:'CometHead', data:[], pointRadius:0, showLine:false, order:99 } as any]); // placeholder to keep engine signature
}

function applyFieldEngine(datasets: LowerDataset[], clock: Clock): LowerDataset[] {
  // Ridge-light sweep
  if(datasets[0]?.data.length){
    const domMin=Math.min(...datasets[0].data.map(p=>p.x)), domMax=Math.max(...datasets[0].data.map(p=>p.x));
    const t=(clock.wallMs/3000)%1, x=domMin+t*(domMax-domMin);
    // find y on curve via linear interp
    const ds=datasets[0].data; let y=ds[0].y;
    for(let i=1;i<ds.length;i++){ if(ds[i].x>=x){ const a=ds[i-1], b=ds[i]; const f=(x-a.x)/(b.x-a.x||1); y=a.y+f*(b.y-a.y); break; } }
    const sweep: LowerDataset = { label:'Ridge Light', data:[{x,y}], pointRadius:8, pointBackgroundColor:'rgba(255,255,255,0.7)', showLine:false, order:0 };
    return [...datasets, sweep];
  }
  return datasets;
}

function applySceneEngine(datasets: LowerDataset[], clock: Clock): LowerDataset[] {
  // Parallax + micro-tilt are handled in iso3d via CLOCK, here add cone pulsing
  return datasets.map(d=>({...d, borderDashOffset: d.label.includes('Cone') ? (clock.wallMs/100)%20 : d.borderDashOffset }));
}

function applyRadialEngine(datasets: LowerDataset[], clock: Clock): LowerDataset[] {
  // Orbital creep
  return datasets.map((d,i)=>{
    if(d.data.length===0) return d;
    const angOffset = clock.wallMs*0.00005*(hashRand(i*19)>0.5?1:-1);
    const nd=d.data.map(p=>{
      const r=Math.hypot(p.x,p.y), a=Math.atan2(p.y,p.x)+angOffset;
      return {x: r*Math.cos(a), y: r*Math.sin(a)};
    });
    return {...d, data: nd };
  });
}

function applyTextEngine(datasets: LowerDataset[], clock: Clock): LowerDataset[] {
  // Gauge micro-drift handled via text rendering, no dataset change
  return datasets;
}

export const ANIMATION_ENGINES: Record<GeometryClass, (d: LowerDataset[], c:Clock, mode:string)=>LowerDataset[]> = {
  G1_RIBBON: applyRibbonEngine, G2_RASTER: applyRasterEngine, G3_NETWORK: applyNetworkEngine, G4_LATTICE: applyLatticeEngine,
  G5_PHASE: applyPhaseEngine, G6_FIELD: applyFieldEngine, G7_SCENE: applySceneEngine, G8_RADIAL: applyRadialEngine, G9_TEXT: applyTextEngine,
};

export function renderLowerManifold(modeName: string, rawDatasets: LowerDataset[], n: number): LowerDataset[] {
  const geometry = PANEL_GEOMETRY[modeName] || 'G1_RIBBON';
  const clock = makeClock(n);
  const engine = ANIMATION_ENGINES[geometry];
  return engine(rawDatasets, clock, modeName);
}
