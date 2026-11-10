import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// split() lives in a browser module that imports the DOM; test the function's source in isolation.
const source = readFileSync(new URL('../web/classes.js', import.meta.url), 'utf8');
const split = new Function(`${/function split[\s\S]*?\n}\n/.exec(source)[0]}; return split;`)();

test('class lists split on whitespace and outer commas, never inside brackets', () => {
  assert.deepEqual(split('text-[clamp(40px,3.5vw,58px)] font-black uppercase'), ['text-[clamp(40px,3.5vw,58px)]', 'font-black', 'uppercase']);
  assert.deepEqual(split('p-4, m-2'), ['p-4', 'm-2']);
  assert.deepEqual(split('font-[Georgia,serif] bg-[url(a,b)]'), ['font-[Georgia,serif]', 'bg-[url(a,b)]']);
  assert.deepEqual(split(''), []);
});
