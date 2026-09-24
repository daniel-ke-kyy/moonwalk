import { createServer } from 'node:net'
import { readFile, mkdir, lstat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PostprocessRuntime } from './postprocessRuntime.js'
import { sandboxRun } from './localSandbox.js'
import { confined } from './nativeRuntime.js'
import { ProjectError } from './projectStore.js'
import { validateSvgInput } from './authoringRuntime.js'

const bridge = fileURLToPath(new URL('./visualBridge.py', import.meta.url))
const probe = fileURLToPath(new URL('./visionProbe.py', import.meta.url))
const editor = fileURLToPath(new URL('./svgReviewEdit.py', import.meta.url))

async function availablePort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

export class VisualRuntime extends PostprocessRuntime {
  constructor(native, { browserRoot = path.resolve('.ppt-runtime/browsers') } = {}) { super(native); this.browserRoot = browserRoot }
  config(record) {
    const config = super.config(record)
    return { ...config, extraReads: [...config.extraReads, bridge, probe, editor] }
  }
  async prepare(record, signal) {
    await super.prepare(record, signal)
    for (const directory of ['.preview', '.review', '.review/backup']) {
      const target = path.join(this.native.projectPath(record), directory)
      await mkdir(target, { recursive: true, mode: 0o700 })
      if (!(await lstat(target)).isDirectory()) throw new ProjectError('视觉审查目录无效。')
    }
  }
  async challenge(record, signal) {
    const result = await sandboxRun(this.config(record), [probe], { signal })
    if (result.code) throw new ProjectError('图片能力验证环境不可用，未开始审查。', 503)
    return JSON.parse(result.output)
  }
  async render(record, pages, signal) {
    const snapshot = await this.snapshot(record)
    for (const name of Object.keys(snapshot).filter((name) => name.endsWith('.svg'))) validateSvgInput(await readFile(await confined(this.native.projectPath(record), name), 'utf8'))
    const renderPort = await availablePort()
    const result = await sandboxRun({ ...this.config(record), renderPort, browserRoot: this.browserRoot },
      [bridge, this.native.skillRoot, this.native.projectPath(record), String(renderPort)], {
        signal, input: JSON.stringify({ pages }), timeout: 180000,
      })
    if (result.code) throw new ProjectError(`原生视觉截图失败，审查未通过：${(result.error || result.output).slice(-1400)}`, 503)
    const records = JSON.parse(result.output).pages
    for (const page of records) {
      if (!page.ok || page.all_background || !page.canvas?.png_width || !page.canvas?.png_height) throw new ProjectError(`页面 ${page.page} 截图为空白或未成功，不能标记审查通过。`, 409)
      const name = `.preview/${path.basename(page.page, '.svg')}.png`
      const bytes = await readFile(await confined(this.native.projectPath(record), name))
      if (bytes.length < 24 || bytes.length > 12 * 1024 * 1024 || bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a'
        || bytes.readUInt32BE(16) !== page.canvas.png_width || bytes.readUInt32BE(20) !== page.canvas.png_height) throw new ProjectError('截图尺寸或文件无效。', 409)
      page.image = bytes.toString('base64')
      page.path = name
    }
    return records
  }
  async edit(record, svg, edits, signal) {
    const result = await sandboxRun(this.config(record), [editor], {
      signal, input: JSON.stringify({ action: edits ? 'edit' : 'inspect', svg, edits }),
    })
    if (result.code) throw new ProjectError('修正超出位置、间距或字号允许范围，需人工确认。', 409)
    return JSON.parse(result.output)
  }
}
