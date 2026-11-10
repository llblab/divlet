export const flatMesh = () => ({ type: 'mesh_gradient', columns: 2, rows: 2, colors: ['#ff0000', '#0000ff', '#ff0000', '#0000ff'] });
export const warpedMesh = () => ({ type: 'mesh_gradient', columns: 3, rows: 3, colors: ['#2468cc','#2468cc','#2468cc','#2468cc','#ffffff','#2468cc','#2468cc','#2468cc','#2468cc'], points: [[0,0],[.5,0],[1,0],[0,.5], { position: [.52,.48], leftHandle: [-.22,.02], rightHandle: [.2,-.04], topHandle: [.03,-.18], bottomHandle: [-.03,.2] }, [1,.5],[0,1],[.5,1],[1,1]] });
export const meshSource = () => ({ version: '2.21', fileToken: 'MESH-SOURCE-ONLY', variables: { ink: { type: 'color', value: '#ff0000' } }, children: [
  { id: 'tile', type: 'rectangle', reusable: true, width: 128, height: 128, fill: { ...flatMesh(), colors: ['$ink','#0000ff','$ink','#0000ff'] }, foreign: { retained: true } },
  { id: 'page', type: 'frame', width: 240, height: 160, x: 200, layout: 'none', fill: '#fff', children: [{ id: 'copy', type: 'ref', ref: 'tile', width: 160, height: 80, x: 12, y: 12 }] },
] });
