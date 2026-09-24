// Dedicated test-service entry point. Never mount this on the production app.
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'

const report = { status: 'running', exitCode: null, output: '' }
const files = (await readdir('server/ppt')).filter((name) => name.endsWith('.test.js')).map((name) => `server/ppt/${name}`)
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: '/tmp', NODE_ENV: 'test',
    PPT_MASTER_SKILL_ROOT: process.env.PPT_MASTER_SKILL_ROOT, PPT_PYTHON: process.env.PPT_PYTHON,
    PPT_BROWSER_ROOT: process.env.PPT_BROWSER_ROOT, PPT_LINUX_SANDBOX: process.env.PPT_LINUX_SANDBOX },
})
for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => {
  report.output = (report.output + data.toString()).slice(-60000)
})
child.on('error', (error) => { report.status = 'failed'; report.output += error.message })
child.on('exit', (code) => { report.exitCode = code; report.status = code === 0 ? 'passed' : 'failed' })
createServer((req, res) => {
  if (!['/health', '/capabilities'].includes(req.url)) { res.writeHead(404).end(); return }
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(req.url === '/health' ? { ok: true } : report))
}).listen(Number(process.env.PORT || 10000), '0.0.0.0')
