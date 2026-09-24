import assert from 'node:assert/strict'
import { test } from 'node:test'

test('default providers send the selected models and preserve JSON contracts', async () => {
  const keys = ['OPENAI_MODEL', 'OPENAI_REASONING_EFFORT', 'DEEPSEEK_MODEL', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY']
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  const originalFetch = globalThis.fetch
  const requests = []
  try {
    for (const key of keys) delete process.env[key]
    process.env.OPENAI_API_KEY = 'test-key'
    process.env.DEEPSEEK_API_KEY = 'test-key'
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body)
      requests.push(body)
      const content = JSON.stringify({ title: 'Test summary', keyPoints: [], sections: [] })
      return Response.json(body.messages
        ? { choices: [{ message: { content } }] }
        : { output: [{ type: 'message', content: [{ type: 'output_text', text: content }] }] })
    }
    const { getAiProvider, listAiProviders, assertAiProviderReady } = await import('./aiProviders.js')
    const prepared = { textContext: 'Test material', processingNotes: [] }
    const file = { originalName: 'test.txt', extension: '.txt' }
    for (const id of ['deepseek', 'openai']) {
      const provider = getAiProvider(id)
      assertAiProviderReady(provider)
      assert.equal((await provider.module.analyzeMaterial(prepared, file)).title, 'Test summary')
    }
    assert.equal(requests[0].model, 'deepseek-flash')
    assert.equal(requests[0].thinking.type, 'disabled')
    assert.equal(requests[0].response_format.type, 'json_object')
    assert.equal(requests[1].model, 'gpt-5.6-sol')
    assert.equal(requests[1].reasoning.effort, 'medium')
    assert.equal(requests[1].text.format.type, 'json_object')
    assert.deepEqual(listAiProviders().map(({ model }) => model), ['deepseek-flash', 'gpt-5.6-sol'])
  } finally {
    globalThis.fetch = originalFetch
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
})
