/*
 * Owns: host-independent history-item replay into a private frame/settings candidate and endpoint version coalescing.
 * Excludes: queues, stack/point authority, whole-project preparation, persistence, publication and host capabilities.
 */
import { applyDocumentPatch, validateDocument, DivletError } from './model.ts';
import type { DocumentModel } from './model.ts';
import { patchSettings } from './project.ts';
import type { ProjectSettings } from './project.ts';
import { matchesPatch, matchesDocumentHistoryPatch, documentHistoryPatch } from './diff.ts';
import type { ValuePatch, DocumentHistoryPatch } from './diff.ts';
import { sameDocument, sameSettings, settingsPatch } from './acceptance.ts';
import { sameJson } from './validation.ts';
import type { HistoryDirection } from './history.ts';
export { documentHistoryPatch } from './diff.ts';

/** Session-owned records, not a wire format or an admission boundary for foreign history. */
export type HistoryReplayItem = Readonly<
  | ({ type: 'patch'; documentId: string } & DocumentHistoryPatch)
  | { type: 'project'; inverse: ValuePatch; forward: ValuePatch }
  | { type: 'order'; inverse: readonly string[]; forward: readonly string[] }
  | { type: 'create' | 'delete'; documentId: string; index?: number; document: DocumentModel }>;
export interface HistoryCandidate { frames: Map<string, DocumentModel>; settings: ProjectSettings }

function refuse(message: string): never { throw new DivletError('CANNOT_UNDO', message); }

/** A canonical project transition in replay order; logging, source hashes and publication remain writer-owned. */
export function projectHistoryItems(previous: ReadonlyMap<string, DocumentModel>, previousSettings: ProjectSettings, next: ReadonlyMap<string, DocumentModel>, nextSettings: ProjectSettings): HistoryReplayItem[] {
  const items: HistoryReplayItem[] = [];
  if (!sameSettings(previousSettings, nextSettings)) items.push({ type: 'project', inverse: settingsPatch(nextSettings, previousSettings), forward: settingsPatch(previousSettings, nextSettings) });
  for (const [id, to] of next) {
    const from = previous.get(id);
    if (from && !sameDocument(from, to)) items.push({ type: 'patch', documentId: id, ...documentHistoryPatch(from, to) });
  }
  const before = [...previous.keys()], after = [...next.keys()];
  for (let index = before.length - 1; index >= 0; index--) {
    const id = before[index]!;
    if (!next.has(id)) items.push({ type: 'delete', documentId: id, index, document: structuredClone(previous.get(id)!) });
  }
  for (const [index, id] of after.entries()) if (!previous.has(id)) items.push({ type: 'create', documentId: id, index, document: structuredClone(next.get(id)!) });
  const orderBefore = before.filter(id => next.has(id)), orderAfter = after.filter(id => previous.has(id));
  if (!sameJson(orderBefore, orderAfter)) items.push({ type: 'order', inverse: orderBefore, forward: orderAfter });
  return items;
}

/** Prove the actual transaction in both directions before adopting external source bytes; not foreign-history admission. */
export function assertProjectHistoryRoundTrip(previous: ReadonlyMap<string, DocumentModel>, previousSettings: ProjectSettings, next: ReadonlyMap<string, DocumentModel>, nextSettings: ProjectSettings, items: readonly HistoryReplayItem[]): void {
  const matches = (candidate: HistoryCandidate, frames: ReadonlyMap<string, DocumentModel>, settings: ProjectSettings): boolean => sameSettings(candidate.settings, settings) && sameJson([...candidate.frames.keys()], [...frames.keys()]) && [...frames].every(([id, frame]) => sameDocument(candidate.frames.get(id)!, frame));
  try {
    if (matches(replayHistory(previous, previousSettings, items, 'redo'), next, nextSettings) && matches(replayHistory(next, nextSettings, items, 'undo'), previous, previousSettings)) return;
  } catch { /* An unrepresentable replay is a source refusal, never a partially accepted transaction. */ }
  throw new DivletError('UNSUPPORTED_SOURCE_REPLAY', 'This live source edit cannot round-trip through current Undo/Redo. Restore the accepted source or explicitly reopen it; the board keeps its last working state.');
}

/** Does not mutate inputs; unchanged documents may be shared. Callers prepare and persist the full candidate before acceptance. */
export function replayHistory(previous: ReadonlyMap<string, DocumentModel>, previousSettings: ProjectSettings, items: readonly HistoryReplayItem[], direction: HistoryDirection): HistoryCandidate {
  const undoing = direction === 'undo';
  let frames = new Map(previous), settings = previousSettings;
  for (const item of undoing ? [...items].reverse() : items) {
    switch (item.type) {
      case 'patch': {
        const change = undoing ? item.inverse : item.forward;
        const current = frames.get(item.documentId);
        if (!current || !matchesDocumentHistoryPatch(current, item, undoing)) refuse('Later changes touched the same content.');
        let candidate: DocumentModel;
        if (item.styleBlocks?.length || item.nodeBlocks?.length) {
          // Keep ordinary patch admission, then validate exact snapshot restoration before acceptance.
          const raw: Record<string, any> = applyDocumentPatch(current, change);
          for (const block of item.nodeBlocks ?? []) {
            const value = block[undoing ? 'before' : 'after'];
            if (value === undefined) delete raw.nodes[block.nodeId];
            else raw.nodes[block.nodeId] = structuredClone(value);
          }
          for (const block of item.styleBlocks ?? []) {
            const node = raw.nodes?.[block.nodeId], value = block[undoing ? 'before' : 'after'];
            if (block.address === null) {
              if (value === undefined) { if (node?.type === 'element') refuse('History style block no longer matches its element.'); }
              else { if (node?.type !== 'element') refuse('History style element is missing.'); node.style = Object.fromEntries(value); }
            } else {
              const override = node?.type === 'ref' ? node.descendants?.[block.address] : undefined;
              if (value === undefined) { if (override) delete override.style; }
              else { if (!override) refuse('History style override is missing.'); override.style = Object.fromEntries(value); }
            }
          }
          candidate = validateDocument(raw);
        } else candidate = applyDocumentPatch(current, change);
        frames.set(item.documentId, { ...candidate, version: current.version + 1 });
        break;
      }
      case 'project': {
        const change = undoing ? item.inverse : item.forward, expected = undoing ? item.forward : item.inverse;
        if (!matchesPatch({ ...settings, outputDir: settings.outputDir ?? undefined }, expected, change)) refuse('Later changes touched the same project fields.');
        settings = patchSettings(settings, change);
        break;
      }
      case 'order': {
        const change = undoing ? item.inverse : item.forward, expected = undoing ? item.forward : item.inverse;
        const members = new Set(expected);
        if (!sameJson([...frames.keys()].filter(id => members.has(id)), expected)) refuse('Later changes touched the same frame order.');
        let index = 0;
        // Reorder only this step's members; unrelated later frames keep their slots and content.
        const ids = [...frames.keys()].map(id => members.has(id) ? change[index++]! : id);
        frames = new Map(ids.map(id => [id, frames.get(id)!]));
        break;
      }
      case 'create':
      case 'delete':
        if ((item.type === 'create') === undoing) {
          const current = frames.get(item.documentId);
          if (!current || !sameDocument(current, item.document)) refuse(`Frame ${item.documentId} has changed since this step.`);
          frames.delete(item.documentId);
        } else {
          if (frames.has(item.documentId)) refuse(`Frame ${item.documentId} already exists.`);
          const ordered = [...frames];
          ordered.splice(item.index ?? ordered.length, 0, [item.documentId, item.document]);
          frames = new Map(ordered);
        }
        break;
      default: refuse('Unknown history operation.');
    }
  }
  for (const [id, frame] of frames) {
    const current = previous.get(id);
    if (current) frames.set(id, sameDocument(current, frame) ? current : { ...frame, version: current.version + 1 });
  }
  settings = { ...settings, version: previousSettings.version + (sameSettings(previousSettings, settings) ? 0 : 1) };
  return { frames, settings };
}
