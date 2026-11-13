export default function (pi) {
  pi.registerCommand('divlet-legacy-tools', {
    handler() {
      const aliases = pi.getAllTools().map(tool => tool.name).filter(name => /_divlet$/.test(name));
      pi.setActiveTools([...new Set([...pi.getActiveTools(), ...aliases])]);
    },
  });
  pi.registerProvider('mock', {
    name: 'Mock',
    baseUrl: `http://127.0.0.1:${process.env.MOCK_PORT}/v1`,
    apiKey: 'MOCK_API_KEY',
    api: 'openai-completions',
    models: [{ type: 'chat', id: 'mock-model', name: 'Mock model', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 4096 }],
  });
}
