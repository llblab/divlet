/*
 * Owns: host-independent history-item replay into a private frame/settings candidate and endpoint version coalescing.
 * Excludes: queues, stack/point authority, whole-project preparation, persistence, publication and host capabilities.
 */
import { applyDocumentPatch, validateDocument, DivletError } from './model.ts';
import type { DocumentModel } from './model.ts';
import { patchSettings } from './project.ts';
import type { ProjectSettings } from './project.ts';
import { matchesPatch, matchesDocumentHistoryPatch } from './diff.ts';
import type { ValuePatch, HistoryStyleBlock } from './diff.ts';
import { sameDocument, sameSettings } from './acceptance.ts';
import { sameJson } from './validation.ts';
import type { HistoryDirection } from './history.ts';
export { documentHistoryPatch } from './diff.ts';

/** Session-owned records, not a wire format or an admission boundary for foreign history. */
export type HistoryReplayItem = Readonly<
  | { type: 'patch'; documentId: string; inverse: ValuePatch; forward: ValuePatch; styleBlocks?: readonly HistoryStyleBlock[] }
  | { type: 'project'; inverse: ValuePatch; forward: ValuePatch }
  | { type: 'order'; inverse: readonly string[]; forward: readonly string[] }
  | { type: 'create' | 'delete'; documentId: string; index?: number; document: DocumentModel }>;
export interface HistoryCandidate { frames: Map<string, DocumentModel>; settings: ProjectSettings }

function refuse(message: string): never { throw new DivletError('CANNOT_UNDO', message); }

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
        if (item.styleBlocks?.length) {
          // Keep ordinary patch admission, then validate exact snapshot restoration before acceptance.
          const raw: Record<string, any> = applyDocumentPatch(current, change);
          for (const block of item.styleBlocks) {
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
