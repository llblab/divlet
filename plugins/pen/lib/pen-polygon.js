// Owns: bounded Divlet polygon/fillet geometry; no Pencil-parity claim, source writes or paint policy.
import { DivletError } from '../../../core/lib/model.ts';

/** Top-first clockwise vertices on the bbox ellipse; circular fillets in authored pixel space. */
export function nativePolygonPath(width, height, count = 3, radius = 0) {
  if (![width, height, count, radius].every(Number.isFinite) || width < 1 || height < 1 || width > 16384 || height > 16384 || !Number.isInteger(count) || count < 3 || count > 128 || radius < 0 || radius > 16384) throw new DivletError('UNSUPPORTED_PEN_RENDER', 'Polygon requires fixed dimensions 1–16384, integer sides 3–128 and scalar radius 0–16384.');
  const vertices = Array.from({ length: count }, (_, i) => {
    const angle = -Math.PI / 2 + i * 2 * Math.PI / count;
    return [width / 2 * (1 + Math.cos(angle)), height / 2 * (1 + Math.sin(angle))];
  });
  const clean = value => String(Number(value.toPrecision(15)));
  const point = p => p.map(clean).join(' ');
  if (!radius) return `M${point(vertices[0])}${vertices.slice(1).map(p => `L${point(p)}`).join('')}Z`;
  const corners = vertices.map((p, i) => {
    const prev = vertices[(i + count - 1) % count], next = vertices[(i + 1) % count];
    const before = Math.hypot(prev[0] - p[0], prev[1] - p[1]), after = Math.hypot(next[0] - p[0], next[1] - p[1]);
    const u = p.map((x, k) => (prev[k] - x) / before), v = p.map((x, k) => (next[k] - x) / after);
    const tanHalf = Math.tan(Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1]))) / 2);
    // At most half of each adjacent edge: neighboring fillets cannot overlap, even in non-square boxes.
    const distance = Math.min(radius / tanHalf, before / 2, after / 2);
    return { in: p.map((x, k) => x + u[k] * distance), out: p.map((x, k) => x + v[k] * distance), radius: distance * tanHalf };
  });
  return `M${point(corners[0].in)}${corners.map((c, i) => `${i ? `L${point(c.in)}` : ''}A${clean(c.radius)} ${clean(c.radius)} 0 0 1 ${point(c.out)}`).join('')}Z`;
}
