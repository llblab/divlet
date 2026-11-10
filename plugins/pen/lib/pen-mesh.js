// Owns: bounded Divlet Coons-mesh raster/PNG projection; no Pencil-parity claim, source or resource I/O.
import { deflateSync, crc32 } from 'node:zlib';
import { DivletError } from '../../../core/lib/model.ts';

export const MESH_LIMITS = Object.freeze({ size: 128, subdivisions: 32, pixels: 262144, triangles: 131072, samples: 8388608, css: 16000 });
const fail = () => { throw new DivletError('UNSUPPORTED_PEN_RENDER', 'Unsupported mesh grid, controls, colors, compositing or encoded output.'); };
const point = (p, bound) => Array.isArray(p) && p.length === 2 && p.every(v => Number.isFinite(v) && Math.abs(v) <= bound);
const add = (a, b) => a.map((v, i) => v + b[i]);
const bezier = (a, b, c, d, t) => a.map((v, i) => (1-t)**3*v + 3*(1-t)**2*t*b[i] + 3*(1-t)*t*t*c[i] + t**3*d[i]);
const mix = (a, b, c, d, u, v) => a.map((x, i) => (1-u)*(1-v)*x + u*(1-v)*b[i] + (1-u)*v*c[i] + u*v*d[i]);
const cross = (a, b, c) => (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0]);

function png(rgba, size) {
  const stride = size * 4, filtered = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    filtered[y * (stride + 1)] = 4;
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x, a = x >= 4 ? rgba[at-4] : 0, b = y ? rgba[at-stride] : 0, c = y && x >= 4 ? rgba[at-stride-4] : 0, p = a+b-c;
      const pa = Math.abs(p-a), pb = Math.abs(p-b), pc = Math.abs(p-c), prediction = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      filtered[y*(stride+1)+x+1] = (rgba[at]-prediction) & 255;
    }
  }
  const chunk = (name, data) => {
    const type = Buffer.from(name), out = Buffer.alloc(data.length+12); out.writeUInt32BE(data.length); type.copy(out,4); data.copy(out,8); out.writeUInt32BE(crc32(Buffer.concat([type,data])),data.length+8); return out;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size,4); header[8]=8; header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR',header), chunk('IDAT',deflateSync(filtered,{level:9})), chunk('IEND',Buffer.alloc(0))]);
}

/** Explicit fallback: neighbor-third handles, Coons boundaries, tessellated premultiplied sRGB, fixed normalized raster. */
export function nativeMeshImage(paint, { number, color, boolean, budget = { pixels: 0, triangles: 0, samples: 0 } }) {
  if (!paint || paint.type !== 'mesh_gradient') fail();
  if (paint.enabled !== undefined && !boolean(paint.enabled)) return null;
  if (paint.blendMode !== undefined && paint.blendMode !== 'normal') fail();
  const cols = paint.columns === undefined ? 3 : paint.columns, rows = paint.rows === undefined ? 3 : paint.rows, opacity = paint.opacity === undefined ? 1 : number(paint.opacity);
  if (![cols,rows].every(n => Number.isInteger(n) && n >= 2 && n <= 8) || !Number.isFinite(opacity) || opacity < 0 || opacity > 1 || !Array.isArray(paint.colors) || paint.colors.length !== cols*rows || paint.points !== undefined && (!Array.isArray(paint.points) || paint.points.length !== cols*rows)) fail();
  const charge = (key, n) => {
    if (!Number.isSafeInteger(budget[key]) || budget[key] < 0 || (budget[key] += n) > MESH_LIMITS[key]) throw new DivletError('TOO_LARGE', 'Mesh projection exceeds its cumulative frame work budget.');
  };
  const vertices = paint.colors.map((raw, i) => {
    const literal = color(raw); if (!/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(literal)) fail();
    let hex = literal.slice(1); if (hex.length <= 4) hex = [...hex].map(c => c+c).join(''); if (hex.length === 6) hex += 'ff';
    const channels = [0,2,4,6].map(at => parseInt(hex.slice(at,at+2),16)), alpha = channels[3]/255, rgba = [channels[0]*alpha,channels[1]*alpha,channels[2]*alpha,alpha];
    const x = i%cols, y = Math.floor(i/cols), regular = [x/(cols-1),y/(rows-1)], rawPoint = paint.points?.[i], record = rawPoint === undefined ? {} : Array.isArray(rawPoint) ? { position: rawPoint } : rawPoint;
    if (!record || typeof record !== 'object' || Array.isArray(record)) fail();
    const p = record.position === undefined && rawPoint === undefined ? regular : record.position;
    if (!point(p,1) || p.some(v => v < 0) || (x===0 || x===cols-1 || y===0 || y===rows-1) && p.some((v,k) => Math.abs(v-regular[k]) > 1e-9)) fail();
    for (const key of ['leftHandle','rightHandle','topHandle','bottomHandle']) if (record[key] !== undefined && !point(record[key],2)) fail();
    return { p, rgba, record };
  });
  const at = (x,y) => vertices[y*cols+x];
  for (let y=0; y<rows; y++) for (let x=0; x<cols; x++) {
    const n=at(x,y), horizontal = at(Math.min(cols-1,x+1),y).p.map((v,k) => (v-at(Math.max(0,x-1),y).p[k])/(x>0 && x<cols-1 ? 6 : 3)), vertical = at(x,Math.min(rows-1,y+1)).p.map((v,k) => (v-at(x,Math.max(0,y-1)).p[k])/(y>0 && y<rows-1 ? 6 : 3));
    for (const [key,delta,sign] of [['leftHandle',horizontal,-1],['rightHandle',horizontal,1],['topHandle',vertical,-1],['bottomHandle',vertical,1]]) n[key] = add(n.p,n.record[key] ?? delta.map(v=>v*sign));
    // Fixed outer edges must remain on the box boundary, including their used controls.
    for (const [axis,edge,keys] of [[1,y===0 || y===rows-1,['leftHandle','rightHandle']],[0,x===0 || x===cols-1,['topHandle','bottomHandle']]]) if (edge) for (const key of keys) if (Math.abs(n[key][axis]-n.p[axis])>1e-9) fail();
  }
  const size=MESH_LIMITS.size, steps=MESH_LIMITS.subdivisions; charge('pixels',size*size); charge('triangles',(cols-1)*(rows-1)*steps*steps*2);
  const rgba=Buffer.alloc(size*size*4), covered=new Uint8Array(size*size);
  const raster = (a,b,c) => {
    const area=cross(a.p,b.p,c.p); if (!Number.isFinite(area) || area<=1e-10) fail();
    const minX=Math.max(0,Math.ceil(Math.min(a.p[0],b.p[0],c.p[0])-.5)), maxX=Math.min(size-1,Math.floor(Math.max(a.p[0],b.p[0],c.p[0])-.5)), minY=Math.max(0,Math.ceil(Math.min(a.p[1],b.p[1],c.p[1])-.5)), maxY=Math.min(size-1,Math.floor(Math.max(a.p[1],b.p[1],c.p[1])-.5));
    charge('samples',Math.max(0,maxX-minX+1)*Math.max(0,maxY-minY+1));
    for(let y=minY;y<=maxY;y++) for(let x=minX;x<=maxX;x++) {
      const p=[x+.5,y+.5], u=cross(p,b.p,c.p)/area, v=cross(p,c.p,a.p)/area, w=1-u-v; if(Math.min(u,v,w)<-1e-7) continue;
      const alpha=u*a.color[3]+v*b.color[3]+w*c.color[3], offset=(y*size+x)*4;
      for(let k=0;k<3;k++) rgba[offset+k]=alpha>1e-12 ? Math.round(Math.max(0,Math.min(255,(u*a.color[k]+v*b.color[k]+w*c.color[k])/alpha))) : 0;
      rgba[offset+3]=Math.round(Math.max(0,Math.min(1,alpha*opacity))*255); covered[y*size+x]=1;
    }
  };
  for(let y=0;y<rows-1;y++) for(let x=0;x<cols-1;x++) {
    const a=at(x,y), b=at(x+1,y), c=at(x,y+1), d=at(x+1,y+1), grid=[];
    for(let j=0;j<=steps;j++) for(let i=0;i<=steps;i++) {
      const u=i/steps,v=j/steps, top=bezier(a.p,a.rightHandle,b.leftHandle,b.p,u), bottom=bezier(c.p,c.rightHandle,d.leftHandle,d.p,u), left=bezier(a.p,a.bottomHandle,c.topHandle,c.p,v), right=bezier(b.p,b.bottomHandle,d.topHandle,d.p,v), bilinear=mix(a.p,b.p,c.p,d.p,u,v);
      const p=top.map((n,k)=>((1-v)*n+v*bottom[k]+(1-u)*left[k]+u*right[k]-bilinear[k])*size);
      grid.push({p,color:mix(a.rgba,b.rgba,c.rgba,d.rgba,u,v)});
    }
    for(let j=0;j<steps;j++) for(let i=0;i<steps;i++) {
      const index=j*(steps+1)+i, a=grid[index],b=grid[index+1],c=grid[index+steps+1],d=grid[index+steps+2]; raster(a,b,d);raster(a,d,c);
    }
  }
  if(covered.some(v=>!v)) fail();
  const css=`url("data:image/png;base64,${png(rgba,size).toString('base64')}")`; if(css.length>MESH_LIMITS.css) fail(); return css;
}
