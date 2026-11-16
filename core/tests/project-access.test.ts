import test from 'node:test';
import assert from 'node:assert/strict';
import * as project from '../lib/project.ts';
import * as history from '../lib/history-replay.ts';
import { projectAccessCases, projectAccessSource } from './fixtures/project-access.js';

const api = { ...project, ...history };
for (const row of projectAccessCases) test(`shared project byte access: ${row.name}`, () => {
  assert.deepEqual(row.run(api), row.expected);
});

test('omitted access retains native project defaults', () => {
  const source = projectAccessSource(), admitted = project.readProject(source);
  assert.deepEqual(admitted.settings.assets, source.assets);
  assert.deepEqual(JSON.parse(project.writeProject(admitted.settings, admitted.frames)).assets, source.assets);
});
