export default function (pi) {
  pi.registerProvider('mock', {
    name: 'Mock',
    baseUrl: `http://127.0.0.1:${process.env.MOCK_PORT}/v1`,
    apiKey: 'MOCK_API_KEY',
    api: 'openai-completions',
    models: [{ type: 'chat', id: 'mock-model', name: 'Mock model', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 4096 }],
  });
}
