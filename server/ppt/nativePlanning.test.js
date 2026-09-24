import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, symlink, mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { ProjectStore } from './projectStore.js'
import { NativeRuntime, confined, runProcess } from './nativeRuntime.js'
import { PlanningController } from './planningController.js'
import { createPptRouter } from './router.js'
import { planStage, modelTurn } from './planningAgent.js'
import { rewriteNativeResponse } from './confirmationProxy.js'

const stage1 = {
  stage: 'stage1', lang: 'zh', primary_language: 'zh-CN', recommend: { canvas: 'ppt169' },
  audience: { value: '测试读者' }, communication_intent: { value: '解释工作流程' },
  audience_outcome: { value: '理解确认步骤' }, core_message: { value: '必须先确认再制作' },
  delivery_context: { value: '现场讲解' }, artifact_afterlife: { value: '内部阅读' }, content_divergence: { value: '' },
}
const candidate = {
  id: 'clear', name: '清晰简洁', note: '面向测试的方案', mode: 'custom', mode_behavior: '按问题、证据和结论组织叙事。',
  visual_style: 'custom', visual_style_behavior: '使用白底、严格栅格、绿色强调与紧凑图表。', icons: 'tabler-outline',
  color: { name: '森林绿', palette: { background: '#FFFFFF', secondary_bg: '#F0F4F2', primary: '#164B3F', accent: '#C64738', secondary_accent: '#347F70', body_text: '#202923' } },
  typography: { name: '中文黑体', heading: { primary: 'Microsoft YaHei', english: 'Arial', css: 'sans-serif' }, body: { primary: 'Microsoft YaHei', english: 'Arial', css: 'sans-serif' }, body_size: 24 },
  image_strategy: { name: '信息图', rendering: 'custom', visual: '平面示意图', mood: '克制', behavior: '根据事实绘制结构与关系。' },
}
const stage2 = {
  stage: 'stage2', lang: 'zh', recommend: { delivery_purpose: 'balanced', mode: 'custom', visual_style: 'custom', image_strategy: 'custom', image_usage: ['none'], generation_mode: 'continuous' },
  page_count: { value: '5' }, proactive_speaker_notes: { value: true }, proactive_custom_animations: { value: false }, proactive_narration_audio: { value: false }, refine_spec: { value: false }, design_spec_depth: { value: 'complete' },
  design_directions: { selected: 0, candidates: [candidate, { ...candidate, id: 'evidence', name: '证据导向' }, { ...candidate, id: 'journey', name: '过程导向' }] },
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mw-native-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await new ProjectStore(root).init()
  return { root, store, ...(await store.create({ aiProvider: 'deepseek', prompt: '制作五页关于团队协作的内部汇报，不增加外部事实。' })) }
}

test('tool filesystem rejects traversal and symlink escape', async (t) => {
  const { root } = await fixture(t)
  const inner = path.join(root, 'safe')
  await mkdir(inner)
  await writeFile(path.join(root, 'secret'), 'private')
  await symlink(path.join(root, 'secret'), path.join(inner, 'link.md'))
  await assert.rejects(confined(inner, '../secret'))
  await assert.rejects(confined(inner, 'link.md'))
  await assert.rejects(confined(inner, '/etc/passwd'))
})

test('native URL adapter preserves prose and only rewrites root resources', () => {
  const response = { contentType: 'text/html', body: Buffer.from('<script src="/static/app.js"></script><p>test</p>') }
  assert.equal(rewriteNativeResponse(response, '/native/abc'), '<script src="/native/abc/static/app.js"></script><p>test</p>')
})

test('tool loop uses selected provider, repairs invalid recommendations and cannot execute shell', async () => {
  let turns = 0, submissions = 0
  const historySeen = []
  await planStage({ record: { aiProvider: 'openai', prompt: 'test', files: [], visualReview: true }, stage: 1,
    runtime: { read: async () => ({ text: 'contract' }), recommend: async () => { submissions++; return { accepted: true } } },
    signal: new AbortController().signal,
    turn: async (provider, _instructions, history) => {
      assert.equal(provider, 'openai')
      historySeen.push([...history])
      turns++
      return turns === 1 ? [{ id: 'bad', name: 'exec', arguments: '{"cmd":"cat .env"}' }]
        : [{ id: 'good', name: 'submit_recommendation', arguments: '{"json":"{}"}' }]
    },
  })
  assert.equal(submissions, 1)
  assert.match(historySeen[1].at(-1).output, /error/)
})

test('Responses and DeepSeek tool adapters preserve reasoning and do not silently switch models', async () => {
  const saved = { openai: process.env.OPENAI_API_KEY, deepseek: process.env.DEEPSEEK_API_KEY }
  process.env.OPENAI_API_KEY = 'test-key'
  process.env.DEEPSEEK_API_KEY = 'test-key'
  try {
    for (const provider of ['openai', 'deepseek']) {
      const history = [{ role: 'user', content: 'test' }]
      const result = await modelTurn(provider, 'instructions', history, { fetchImpl: async (_url, options) => {
        const request = JSON.parse(options.body)
        assert.ok(request.tools.length)
        if (provider === 'openai') {
          assert.equal(request.reasoning.effort, process.env.OPENAI_REASONING_EFFORT || 'medium')
          return Response.json({ output: [{ type: 'reasoning', encrypted_content: 'opaque', summary: [] }, { type: 'function_call', call_id: 'a', name: 'read_file', arguments: '{}' }] })
        }
        return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', reasoning_content: 'opaque', content: null, tool_calls: [{ id: 'a', function: { name: 'read_file', arguments: '{}' } }] } }] })
      } })
      assert.equal(result[0].name, 'read_file')
      assert.ok(JSON.stringify(history).includes('opaque'))
      await assert.rejects(modelTurn(provider, '', [], { fetchImpl: async () => new Response('', { status: 401 }) }), /未切换模型/)
    }
  } finally {
    for (const [provider, key] of Object.entries(saved)) {
      const name = provider === 'openai' ? 'OPENAI_API_KEY' : 'DEEPSEEK_API_KEY'
      if (key === undefined) delete process.env[name]; else process.env[name] = key
    }
  }
})

const nativeAvailable = Boolean(process.env.PPT_MASTER_SKILL_ROOT && process.env.PPT_PYTHON)
test('planning resumes complete tool rounds and invalidates history when the request changes', async (t) => {
  const { root } = await fixture(t)
  const record = { id: 'resume', aiProvider: 'openai', prompt: 'original', files: [], visualReview: true }
  const runtime = { store: { directory: () => root }, read: async () => ({ text: 'reference' }),
    recommend: async () => ({ accepted: true }) }
  const controller = new AbortController()
  await assert.rejects(planStage({ record, stage: 1, runtime, signal: controller.signal,
    turn: async (_provider, _instructions, history) => {
      const call = { type: 'function_call', call_id: 'read-1', name: 'read_file', arguments: '{"scope":"skill","path":"reference.md","offset":0}' }
      history.push({ type: 'reasoning', encrypted_content: 'preserved', summary: [] }, call)
      return [{ id: call.call_id, ...call }]
    }, checkpoint: async (value) => { if (value.lastTool) controller.abort() },
  }))
  const saved = JSON.parse(await readFile(path.join(root, 'planning-stage1-checkpoint.json'), 'utf8'))
  assert.equal(saved.rounds, 1)
  assert.equal(saved.history.at(-1).type, 'function_call_output')
  const run = (changed) => planStage({ record: changed, stage: 1, runtime, signal: new AbortController().signal,
    turn: async (_provider, _instructions, history) => {
      if (changed.prompt === 'original') assert.ok(history.some((item) => item.encrypted_content === 'preserved'))
      else assert.equal(history.length, 1)
      return [{ id: 'submit', name: 'submit_recommendation', arguments: '{"json":"{}"}' }]
    },
  })
  assert.equal((await run(record)).accepted, true)
  assert.equal((await run({ ...record, prompt: 'changed' })).accepted, true)
})

test('real native intake converts PDF, DOCX and PPTX without the learning-material parser', { skip: !nativeAvailable }, async (t) => {
  const { root, store, project, recoveryToken } = await fixture(t)
  await runProcess(process.env.PPT_PYTHON, [fileURLToPath(new URL('./fixtures/create_sources.py', import.meta.url)), root], { cwd: root })
  const files = []
  for (const extension of ['pdf', 'docx', 'pptx']) {
    const file = path.join(root, `sample.${extension}`)
    files.push({ path: file, originalName: `材料.${extension}`, size: (await stat(file)).size })
  }
  const record = await store.addFiles(project.id, recoveryToken, files)
  const runtime = new NativeRuntime(store, { skillRoot: process.env.PPT_MASTER_SKILL_ROOT, python: process.env.PPT_PYTHON })
  await runtime.prepare(record)
  for (const file of record.files) {
    const content = await runtime.read(record, 'project', `sources/${path.parse(file.name).name}.md`)
    assert.match(content.text, /assign an owner/)
  }
})

test('real native two-stage confirmation through private HTTP proxy, restart and final gate', { skip: !nativeAvailable }, async (t) => {
  const { root, store, project, recoveryToken } = await fixture(t)
  const runtime = new NativeRuntime(store, { skillRoot: process.env.PPT_MASTER_SKILL_ROOT, python: process.env.PPT_PYTHON })
  await runtime.check()
  const calledStages = []
  const controller = new PlanningController(store, runtime, { planner: async ({ record, stage, signal }) => {
    calledStages.push(stage)
    await runtime.recommend(record, stage, JSON.stringify(stage === 1 ? stage1 : stage2), signal)
  } })
  t.after(() => controller.close())
  const app = express()
  app.use(express.json())
  app.use('/api/ppt', await createPptRouter(store, { controller }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }))
  const origin = `http://127.0.0.1:${server.address().port}`
  const base = `${origin}/api/ppt/projects/${project.id}`
  const auth = { Authorization: `Bearer ${recoveryToken}` }
  assert.equal((await fetch(`${base}/start`, { method: 'POST', headers: auth })).status, 202)
  await controller.jobs.get(project.id)?.promise
  const waiting = await store.get(project.id, recoveryToken)
  assert.equal(waiting.status, 'awaiting_stage1', waiting.error)
  assert.deepEqual(calledStages, [1])
  assert.equal(await stat(path.join(runtime.projectPath(project), 'confirm_ui/recommendations.stage2.json')).catch(() => null), null)
  const session = await fetch(`${base}/confirmation-session`, { method: 'POST', headers: auth })
  const cookie = session.headers.get('set-cookie').split(';')[0]
  assert.equal((await fetch(`${base}/native/`)).status, 404)
  const nativeHeaders = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }
  const html = await fetch(`${base}/native/`, { headers: nativeHeaders })
  assert.equal(html.status, 200)
  assert.match(await html.text(), new RegExp(`/api/ppt/projects/${project.id}/native/static/app.js`))
  assert.equal((await fetch(`${base}/native/api/health`, { headers: nativeHeaders })).status, 404)
  assert.equal((await fetch(`${base}/native/api/confirm`, { method: 'POST', headers: { ...nativeHeaders, Origin: 'https://evil.invalid' }, body: '{}' })).status, 403)
  const rec = await (await fetch(`${base}/native/api/recommendations`, { headers: nativeHeaders })).json()
  const firstPayload = { stage: 'stage1', primary_language: 'zh-CN', canvas: 'ppt169', audience: '用户修改后的读者',
    options_sha256: rec.template_options.options_sha256, template_selection: { mode: 'free_design', selection_keys: [] } }
  const submit = await fetch(`${base}/native/api/confirm`, { method: 'POST', headers: nativeHeaders, body: JSON.stringify(firstPayload) })
  assert.equal(submit.status, 200, await submit.text())
  await controller.jobs.get(project.id)?.promise
  const second = await store.get(project.id, recoveryToken)
  assert.equal(second.status, 'awaiting_stage2', second.error)
  assert.deepEqual(calledStages, [1, 2])
  assert.equal(second.confirmations[0].receipt.audience, '用户修改后的读者')
  assert.equal((await fetch(`${base}/native/api/confirm`, { method: 'POST', headers: nativeHeaders, body: JSON.stringify(firstPayload) })).status, 409)
  const finalPayload = { stage: 'final', page_count: '5', delivery_purpose: 'balanced', ...candidate,
    typography: { ...candidate.typography, sizes: { title: 36, subtitle: 28, annotation: 16 } },
    image_usage: ['none'], generation_mode: 'continuous', refine_spec: false, design_spec_depth: 'complete',
    proactive_speaker_notes: true, proactive_custom_animations: false, proactive_narration_audio: false }
  const final = await fetch(`${base}/native/api/confirm`, { method: 'POST', headers: nativeHeaders, body: JSON.stringify(finalPayload) })
  assert.equal(final.status, 200, await final.text())
  const complete = await store.get(project.id, recoveryToken)
  assert.equal(complete.status, 'planning_complete')
  assert.equal(complete.confirmations.length, 2)
  assert.deepEqual(await readdirSafe(path.join(runtime.projectPath(project), 'svg_output')), [])
  // Simulate a crash after native final submission but before the website state write.
  const interrupted = await store.read(project.id)
  interrupted.status = 'awaiting_stage2'
  interrupted.confirmations.pop()
  await store.save(interrupted)
  const restarted = new PlanningController(store, runtime)
  await restarted.recover()
  assert.equal((await store.get(project.id, recoveryToken)).status, 'planning_complete')
  assert.equal((await new ProjectStore(root).get(project.id, recoveryToken)).confirmations.length, 2)
})

async function readdirSafe(directory) {
  const { readdir } = await import('node:fs/promises')
  return readdir(directory)
}
