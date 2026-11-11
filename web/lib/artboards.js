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
  const group = newGroup();
  let removed = 0;
  // Frames that use components go before the frames that define them.
  const left = new Set(ids);
  const order = [];
  while (left.size) {
    const next = [...left].find(id => !(descriptor(id)?.usedBy || []).some(user => user !== id && left.has(user))) ?? [...left][0];
    order.push(next);
    left.delete(next);
  }
  const names = new Map(ids.map(id => [id, descriptor(id)?.name || id]));
  leave(ids);
  for (const documentId of order) {
    try { await post('api/artboards/delete', { documentId, group, expectedVersion: descriptor(documentId)?.version, label: ids.length > 1 ? `delete ${ids.length} artboards` : `delete “${names.get(documentId)}”` }); removed++; }
    catch (error) { leave([documentId], true); toast(error.message); }
  }
  if (removed) toast(removed > 1 ? `${removed} artboards deleted` : `“${names.get(ids[0])}” deleted`, { label: 'Undo', run: () => undo() });
}
