// Artboard lifecycle commands; selection, reveal, grouping and failure feedback stay with each accepted operation.
import { descriptor, post, undo, toast, newGroup, selectArtboards, whenDocument, leave } from './store.js';
import * as canvas from './canvas.js';

export async function newArtboard({ x, y, width, height, name } = {}) {
  const narrow = document.documentElement.clientWidth < 720;
  const body = { label: 'new artboard', width: width ?? (narrow ? 390 : 1280), height: height ?? (narrow ? 844 : 800) };
  if (name) body.name = name;
  if (Number.isFinite(x) && Number.isFinite(y)) Object.assign(body, { x: Math.round(x), y: Math.round(y) });
  try {
    const result = await post('api/artboards', body);
    await whenDocument(result.documentId);
    selectArtboards([result.documentId]);
    canvas.reveal(result.documentId);
    return result.documentId;
  } catch (error) { toast(error.message); return null; }
}

export async function duplicateArtboards(ids) {
  if (!ids.length) return;
  const group = newGroup();
  const created = [];
  for (const from of ids) {
    try { created.push((await post('api/artboards', { from, group, expectedVersion: descriptor(from)?.version, label: ids.length > 1 ? `duplicate ${ids.length} artboards` : 'duplicate artboard' })).documentId); }
    catch (error) { toast(error.message); }
  }
  if (!created.length) return;
  await whenDocument(created.at(-1));
  selectArtboards(created);
  canvas.reveal(created[0]);
}

export async function deleteArtboards(ids) {
  if (!ids.length) return;
  const pending = new Map();
  for (const id of ids) {
    const doc = descriptor(id);
    // Absent or already-hidden frames are not a fresh destructive intent.
    if (doc) pending.set(id, { id, name: doc.name || id, version: doc.version, usedBy: doc.usedBy || [] });
  }
  if (!pending.size) return;
  const group = newGroup();
  // Capture targets before optimistic hiding; component consumers go before their definitions.
  const order = [], removed = [];
  while (pending.size) {
    const next = [...pending.values()].find(doc => !doc.usedBy.some(user => user !== doc.id && pending.has(user))) ?? pending.values().next().value;
    order.push(next);
    pending.delete(next.id);
  }
  leave(order.map(doc => doc.id));
  for (const doc of order) {
    try { await post('api/artboards/delete', { documentId: doc.id, group, expectedVersion: doc.version, label: order.length > 1 ? `delete ${order.length} artboards` : `delete “${doc.name}”` }); removed.push(doc); }
    catch (error) { leave([doc.id], true); toast(error.message); }
  }
  if (removed.length) toast(removed.length > 1 ? `${removed.length} artboards deleted` : `“${removed[0].name}” deleted`, { label: 'Undo', run: () => undo() });
}
