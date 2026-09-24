import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { sandboxRun } from './localSandbox.js'
import { ProjectError } from './projectStore.js'

export async function checkCloudWorker(store, { python, skillRoot }) {
  const directory = await mkdtemp(path.join(store.root, '.isolation-check-'))
  const project = path.join(directory, 'workspace', 'deck')
  try {
    await mkdir(path.join(project, 'confirm_ui'), { recursive: true })
    await mkdir(path.join(project, 'svg_output'))
    const receipt = path.join(project, 'confirm_ui', 'result.json')
    const secret = path.join(directory, 'state.json')
    await writeFile(receipt, 'protected')
    await writeFile(secret, 'private', { mode: 0o600 })
    const config = { python, skillRoot, project, storeRoot: store.root }
    const good = await sandboxRun(config, ['-c',
      'import os, pathlib, flask, pptx; assert "OPENAI_API_KEY" not in os.environ; assert "DEEPSEEK_API_KEY" not in os.environ; pathlib.Path("svg_output/check.txt").write_text("ok"); print("isolated-ready")'])
    if (good.code || !good.output.includes('isolated-ready')) throw new Error(good.error || good.output)
    for (const code of [
      `from pathlib import Path; Path(${JSON.stringify(secret)}).read_bytes()`,
      `from pathlib import Path; Path(${JSON.stringify(`/proc/${process.pid}/environ`)}).read_bytes()`,
      'from pathlib import Path; Path("confirm_ui/result.json").write_text("bad")',
      'from pathlib import Path; Path("confirm_ui").rename("receipt-replaced")',
      'import socket; socket.socket().bind(("127.0.0.1",0))',
      'import socket; socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)',
      'import socket; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.sendto(b"probe",("1.1.1.1",53))',
    ]) {
      const result = await sandboxRun(config, ['-c', code], { timeout: 5000 })
      if (result.code === 0) throw new Error('Worker isolation denial failed')
    }
    if (await readFile(receipt, 'utf8') !== 'protected') throw new Error('Receipt was changed')
  } catch (error) {
    throw new ProjectError(`云端执行器隔离检查未通过，PPT 制作未启用：${String(error.message).slice(-1200)}`, 503)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
