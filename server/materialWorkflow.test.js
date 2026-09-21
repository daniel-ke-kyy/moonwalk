import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import AdmZip from 'adm-zip'
import { PDFDocument } from 'pdf-lib'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { inspectDocument, prepareDocumentForAi } from './documentProcessor.js'

const materialText = 'Erasure coding uses data and parity fragments for storage fault tolerance. RDMA reduces CPU overhead during data transfer.'
function pptxFixture(count = 2) {
  const zip = new AdmZip()
  for (let i = 1; i <= count; i++) {
    zip.addFile(`ppt/slides/slide${i}.xml`, Buffer.from(`<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${materialText}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`))
  }
  return zip.toBuffer()
}

test('PPTX material text extraction and the 100-slide limit remain intact', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'moonwalk-material-test-'))
  try {
    const file = path.join(dir, 'material.pptx')
    await writeFile(file, pptxFixture())
    assert.equal((await inspectDocument(file, '.pptx')).slideCount, 2)
    const prepared = await prepareDocumentForAi(file, 'material.pptx', '.pptx')
    assert.match(prepared.textContext, /Erasure coding/)
    assert.match(prepared.textContext, /RDMA/)
    await writeFile(file, pptxFixture(101))
    await assert.rejects(inspectDocument(file, '.pptx'), /100/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('PDF and DOCX learning material extraction remains available', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'moonwalk-formats-test-'))
  try {
    const pdf = await PDFDocument.create()
    pdf.addPage().drawText(materialText, { size: 10, x: 20, y: 500 })
    const pdfPath = path.join(dir, 'material.pdf')
    await writeFile(pdfPath, await pdf.save())
    assert.equal((await inspectDocument(pdfPath, '.pdf')).pageCount, 1)
    assert.match((await prepareDocumentForAi(pdfPath, 'material.pdf', '.pdf')).textContext, /Erasure coding/)
    const zip = new AdmZip()
    zip.addFile('[Content_Types].xml', Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'))
    zip.addFile('_rels/.rels', Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'))
    zip.addFile('word/document.xml', Buffer.from(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${materialText}</w:t></w:r></w:p></w:body></w:document>`))
    const docxPath = path.join(dir, 'material.docx')
    await writeFile(docxPath, zip.toBuffer())
    assert.match((await prepareDocumentForAi(docxPath, 'material.docx', '.docx')).textContext, /Erasure coding/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('material upload, both assessments, access gate and removed generation endpoints', { timeout: 120000 }, async () => {
  let upstreamResponse = {}
  const upstreamRequests = []
  const upstream = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const request = JSON.parse(Buffer.concat(chunks).toString())
    upstreamRequests.push(request)
    const content = JSON.stringify(upstreamResponse)
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(request.messages
      ? { choices: [{ message: { content } }] }
      : { output: [{ type: 'message', content: [{ type: 'output_text', text: content }] }] }))
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`
  const portProbe = createServer()
  portProbe.listen(0, '127.0.0.1')
  await once(portProbe, 'listening')
  const port = portProbe.address().port
  await new Promise(resolve => portProbe.close(resolve))
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', ACCESS_PASSWORD: 'test-only-password',
      OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: `${upstreamUrl}/v1`, OPENAI_API_URL: `${upstreamUrl}/v1/responses`,
      OPENAI_MODEL: 'gpt-5.6-sol', OPENAI_REASONING_EFFORT: 'medium',
      DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_API_URL: `${upstreamUrl}/chat/completions`, DEEPSEEK_MODEL: 'deepseek-flash' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  child.stdout.on('data', chunk => { logs += chunk })
  child.stderr.on('data', chunk => { logs += chunk })
  const base = `http://127.0.0.1:${port}`
  let cookie = ''
  async function request(route, body) {
    return fetch(base + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, ...(body instanceof FormData || body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(70000),
    })
  }
  async function json(route, body) {
    const res = await request(route, body)
    const data = await res.json()
    assert.equal(res.status, 200, JSON.stringify(data))
    return data
  }
  try {
    let ready = false
    for (let i = 0; i < 200; i++) {
      if (child.exitCode !== null) throw new Error(logs)
      try { if ((await request('/api/health')).ok) { ready = true; break } } catch {}
      await delay(50)
    }
    assert.ok(ready, logs)
    const health = await json('/api/health')
    assert.ok(health.limits.allowedExtensions.includes('.pptx'))
    assert.equal(health.limits.maxPptxSlides, 100)
    assert.equal('pptModes' in health.limits, false)
    assert.equal('pptRenderingAvailable' in health, false)
    assert.equal((await request('/api/upload', {})).status, 401)
    assert.equal((await request('/api/auth/login', { password: 'wrong' })).status, 401)
    const login = await request('/api/auth/login', { password: 'test-only-password' })
    assert.equal(login.status, 200)
    cookie = login.headers.get('set-cookie').split(';')[0]
    for (const route of ['/api/ppt/analyze', '/api/ppt/generate', '/api/ppt/revise', '/api/ppt/jobs/test/cancel']) {
      assert.equal((await request(route, {})).status, 404, route)
    }
    for (const route of ['/api/ppt/jobs/test', '/api/ppt/test/download/pptx', '/api/ppt/test/download/pdf', '/api/ppt-files/test.png']) {
      assert.equal((await request(route)).status, 404, route)
    }
    const pdf = await PDFDocument.create()
    pdf.addPage().drawText(materialText, { size: 10, x: 20, y: 500 })
    const pdfBytes = await pdf.save()
    for (const provider of ['deepseek', 'openai']) {
      upstreamResponse = { title: 'Storage', overview: materialText,
        keyPoints: [{ id: 'kp1', title: 'Erasure coding', importance: 'high' }],
        sections: [{ title: 'Storage', keyPointIds: ['kp1'] }] }
      const form = new FormData()
      form.append('aiProvider', provider)
      form.append('file', new Blob([provider === 'deepseek' ? pptxFixture() : pdfBytes]), provider === 'deepseek' ? 'material.pptx' : 'material.pdf')
      const upload = await json('/api/upload', form)
      assert.equal(upload.aiProvider, provider)
      assert.equal(upload.summary.title, 'Storage')
      if (provider === 'deepseek') assert.equal(upload.fileInfo.slideCount, 2)
      else {
        const input = upstreamRequests.at(-1)
        assert.equal(input.reasoning.effort, 'medium')
        assert.ok(Array.isArray(input.input), 'PDF visual context must reach the GPT adapter')
        assert.ok(input.input.some(item => item.content?.some(part => part.type === 'input_image')))
      }
      upstreamResponse = { questions: Array.from({ length: 5 }, (_, i) => ({
        id: `q${i+1}`, type: 'single', stem: 'Which technique provides fault tolerance?',
        options: ['A', 'B', 'C', 'D'].map(id => ({ id, text: id === 'A' ? 'Erasure coding' : 'Other' })),
        answer: ['A'], explanation: 'Data and parity fragments provide fault tolerance.',
      })) }
      const sessionId = upload.sessionId
      const quiz = await json('/api/generate', { sessionId, aiProvider: provider, questionCount: 5, difficulty: '简单', selectedKeyPointIds: ['kp1'] })
      assert.equal(quiz.questions.length, 5)
      assert.deepEqual(quiz.questions[0].answer, ['A'])
      upstreamResponse = { materialType: 'Report', questions: [{ id: 'oq1', prompt: 'What tradeoffs are missing?', sourceRef: { location: 'Page 1', excerpt: 'Erasure coding' } }] }
      const open = await json('/api/open/generate', { sessionId, aiProvider: provider, questionCount: 1, writingGoal: '', selectedSectionIndexes: [0] })
      assert.equal(open.questions.length, 1)
      assert.ok(open.feedbackContext)
      upstreamResponse = { overallDiagnosis: { summary: 'Add evidence', mainIssues: [], nextActions: [] }, feedback: [{ questionId: 'oq1', suggestion: 'Compare capacity overhead.' }] }
      const feedback = await json('/api/open/feedback', { sessionId, aiProvider: provider, answers: { oq1: 'Capacity overhead matters.' } })
      assert.equal(feedback.feedback[0].answered, true)
      const fallback = { ...open.feedbackContext, questionSet: { ...open, writingGoal: '' } }
      const recovered = await json('/api/open/feedback', { sessionId: 'expired', aiProvider: provider, answers: {}, feedbackContext: fallback })
      assert.equal(recovered.feedback[0].answered, false)
      assert.equal((await request('/api/generate', { sessionId, aiProvider: provider === 'deepseek' ? 'openai' : 'deepseek', questionCount: 5, difficulty: '简单', selectedKeyPointIds: ['kp1'] })).status, 400)
    }
    await json('/api/auth/logout', {})
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      await exited
    }
    upstream.closeAllConnections()
    await new Promise(resolve => upstream.close(resolve))
  }
})
