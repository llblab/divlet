// A small static application whose UI and MCP tools share one domain model. Bundled by the test; no backend.
import { createBrowserMcpProvider, exposeBrowserMcp, defineTools, registerWebMcpTools, ToolError } from '@divlet/web/mcp';

const DB = 'todo-fixture';
const open = () => new Promise((resolve, reject) => {
  const request = indexedDB.open(DB, 1);
  request.onupgradeneeded = () => request.result.createObjectStore('todos', { keyPath: 'id' });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const db = await open();
const all = () => new Promise((resolve, reject) => { const request = db.transaction('todos').objectStore('todos').getAll(); request.onsuccess = () => resolve(request.result.sort((a, b) => a.id - b.id)); request.onerror = () => reject(request.error); });
const put = todo => new Promise((resolve, reject) => { const tx = db.transaction('todos', 'readwrite'); tx.objectStore('todos').put(todo); tx.oncomplete = () => resolve(todo); tx.onerror = () => reject(tx.error); });

/* ---- domain: the only place todos change -------------------------------------------------------- */
const domain = {
  list: () => all(),
  async add(text) {
    const todos = await all();
    const todo = { id: (todos.at(-1)?.id ?? 0) + 1, text, done: false };
    await put(todo); render(); return todo;
  },
  async toggle(id) {
    const todo = (await all()).find(item => item.id === id);
    if (!todo) throw new ToolError('NOT_FOUND', `No todo ${id}.`);
    todo.done = !todo.done; await put(todo); render(); return todo;
  },
};

/* ---- human interface ----------------------------------------------------------------------------- */
async function render() {
  const list = document.getElementById('list');
  list.replaceChildren(...(await all()).map(todo => {
    const item = document.createElement('li');
    item.dataset.id = todo.id;
    item.textContent = `${todo.done ? '✓' : '○'} ${todo.text}`;
    item.onclick = () => domain.toggle(todo.id);
    return item;
  }));
}
document.getElementById('add').onsubmit = event => { event.preventDefault(); const input = document.getElementById('text'); if (input.value) domain.add(input.value); input.value = ''; };
await render();

/* ---- agent interface: the same operations ------------------------------------------------------- */
const cancellations = [];
const tools = defineTools([
  { name: 'todos.list', title: 'List todos', description: 'List all todos.', inputSchema: { type: 'object', additionalProperties: false }, annotations: { readOnlyHint: true }, execute: async () => ({ todos: await domain.list() }) },
  { name: 'todos.add', description: 'Add a todo.', inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['text'], additionalProperties: false }, execute: ({ text }) => domain.add(text) },
  { name: 'todos.toggle', description: 'Toggle a todo by id.', inputSchema: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } }, required: ['id'], additionalProperties: false }, execute: ({ id }) => domain.toggle(id) },
  {
    name: 'wait', description: 'Wait, then answer; records cancellation.', inputSchema: { type: 'object', properties: { ms: { type: 'integer', minimum: 0, maximum: 60000 }, tag: { type: 'string' } }, required: ['ms'], additionalProperties: false },
    execute: ({ ms, tag = '' }, { signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ waited: ms, tag }), ms);
      signal.addEventListener('abort', () => { clearTimeout(timer); cancellations.push(tag); document.getElementById('status').textContent = `cancelled:${cancellations.join(',')}`; reject(signal.reason); }, { once: true });
    }),
  },
]);
const webmcp = await registerWebMcpTools(tools);
document.documentElement.dataset.webmcp = webmcp.registered.join(',');
exposeBrowserMcp(createBrowserMcpProvider({ name: 'todo-fixture', version: '1.0.0', instructions: 'A todo list.', tools }));
