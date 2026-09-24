import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../.ppt-runtime/', import.meta.url))
const python = process.env.PPT_PYTHON || path.join(root, 'venv/bin/python')
execFileSync(python, ['-m', 'pip', 'install', 'playwright==1.58.0'], { stdio: 'inherit' })
execFileSync(python, ['-m', 'playwright', 'install', 'chromium', '--only-shell'], {
  stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: process.env.PPT_BROWSER_ROOT || path.join(root, 'browsers') },
})
