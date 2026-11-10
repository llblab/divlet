// Owns: bounded native gradient geometry/serialization; no source writes, resource discovery or promotion.
import { DivletError } from '../../../core/lib/model.ts';

const fail = () => { throw new DivletError('UNSUPPORTED_PEN_RENDER', 'Unsupported PEN gradient paint geometry, stops or compositing.'); };

/** PEN normalized-bbox coordinates, CCW from up. Output is disposable native CSS only. */
export function nativeGradientImage(paint, { number, color, boolean }) {
  if (!paint || paint.type !== 'gradient') fail();
  if (paint.enabled !== undefined && !boolean(paint.enabled)) return null;
  if (paint.blendMode !== undefined && paint.blendMode !== 'normal') fail();
  for (const key of ['center', 'size']) if (paint[key] !== undefined && (!paint[key] || typeof paint[key] !== 'object' || Array.isArray(paint[key]))) fail();
  const type = paint.gradientType ?? 'linear';
  if (!['linear', 'radial'].includes(type)) fail();
  const bounded = (raw, fallback, min, max) => { const value = raw === undefined ? fallback : number(raw); if (!Number.isFinite(value) || value < min || value > max) fail(); return value; };
  const opacity = bounded(paint.opacity, 1, 0, 1), cx = bounded(paint.center?.x, 0.5, 0, 1), cy = bounded(paint.center?.y, 0.5, 0, 1);
  const width = type === 'radial' ? bounded(paint.size?.width, 1, Number.EPSILON, 16) : 1, height = bounded(paint.size?.height, 1, Number.EPSILON, 16);
  const rotation = paint.rotation === undefined ? 0 : number(paint.rotation);
  if (!Number.isFinite(rotation) || !Array.isArray(paint.colors) || paint.colors.length < 2 || paint.colors.length > 256) fail();
  let previous = -Infinity;
  const stops = paint.colors.map(stop => {
    if (!stop || typeof stop !== 'object') fail();
    const value = color(stop.color), offset = bounded(stop.position, undefined, 0, 1);
    if (!/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value) || offset < previous) fail();
    previous = offset;
    return `<stop offset="${offset}" stop-color="${value}"/>`;
  }).join('');
  const angle = rotation % 360, radians = angle * Math.PI / 180;
  const clean = value => String(Math.abs(value) < 1e-14 ? 0 : Number(value.toPrecision(15)));
  let gradient;
  if (type === 'linear') {
    const dx = -Math.sin(radians) * height / 2, dy = -Math.cos(radians) * height / 2;
    gradient = `<linearGradient id="g" x1="${clean(cx - dx)}" y1="${clean(cy - dy)}" x2="${clean(cx + dx)}" y2="${clean(cy + dy)}">${stops}</linearGradient>`;
  } else {
    gradient = `<radialGradient id="g" cx="${cx}" cy="${cy}" r="0.5" gradientTransform="translate(${cx} ${cy}) rotate(${-angle}) scale(${width} ${height}) translate(${-cx} ${-cy})">${stops}</radialGradient>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" preserveAspectRatio="none"><defs>${gradient}</defs><rect width="1" height="1" fill="url(#g)" opacity="${opacity}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
