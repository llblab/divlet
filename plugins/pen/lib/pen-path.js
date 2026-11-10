// Owns: native SVG path viewBox admission/bounds; no geometry rewriting, I/O or source mutation.
import { SVGPathData } from 'svg-pathdata';
import { DivletError, LIMITS } from '../../../core/lib/model.ts';

const fail = () => { throw new DivletError('UNSUPPORTED_PEN_RENDER', 'Unsupported PEN path geometry or implicit bounds.'); };

/** A missing PEN path viewBox means tight geometry bounds, not the displayed node dimensions. */
export function nativePathViewBox(geometry, viewBox) {
  if (typeof geometry !== 'string' || geometry.length > LIMITS.text) fail();
  if (viewBox !== undefined) {
    if (!Array.isArray(viewBox) || viewBox.length !== 4 || viewBox.some(value => !Number.isFinite(value))) fail();
    return [...viewBox];
  }
  let path, bounds;
  try {
    path = new SVGPathData(geometry);
    if (path.commands.some(command => Object.values(command).some(value => typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)))) fail();
    bounds = path.getBounds();
  } catch { fail(); } // Parser errors may contain authored path fragments; never forward them.
  const result = [bounds.minX, bounds.minY, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY];
  if (result.some(value => !Number.isFinite(value)) || result[2] <= 0 || result[3] <= 0) fail();
  return result;
}
