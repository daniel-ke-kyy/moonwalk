import * as THREE from 'three'

type SceneState = { paused: boolean; mode: 'material' | 'questions'; busy: boolean; dragging: boolean }
export type PaperSceneController = { update: (state: SceneState) => void; dispose: () => void }
type Sheet = { group: THREE.Group; surface: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>; material: THREE.Texture; questions: THREE.Texture; index: number }

const FONT = '"PingFang SC", "Microsoft YaHei", sans-serif'
const INK = '#29312f'

// These authored bitmap pages are illustrative product content, not uploaded user data.
function makePage(index: number, questionMode: boolean) {
  const canvas = document.createElement('canvas')
  canvas.width = 720
  canvas.height = 960
  const c = canvas.getContext('2d')!
  const colors = ['#fffefa', '#eef2eb', '#fff8ed', '#edf2f5', '#fffefa']
  c.fillStyle = colors[index]
  c.fillRect(0, 0, 720, 960)
  const text = (value: string, x: number, y: number, size = 28, weight = 400, color = INK) => {
    c.fillStyle = color
    c.font = `${weight} ${size}px ${FONT}`
    c.fillText(value, x, y)
  }
  const line = (y: number, width = 592) => {
    c.fillStyle = '#d8ddd7'
    c.fillRect(64, y, width, 2)
  }
  const tag = (value: string, x: number, y: number, color: string) => {
    c.fillStyle = color
    c.fillRect(x, y, 164, 54)
    text(value, x + 19, y + 36, 23)
  }
  text('Moonwalk', 64, 63, 24, 500)
  text('示例', 595, 63, 19, 400, '#737c73')
  line(91)

  if (questionMode && index === 2) {
    text('答案与解析', 64, 153, 24, 400, '#60774f')
    text('正确答案：B', 64, 254, 52, 600)
    text('合上材料，', 64, 348, 40, 500)
    text('复述核心观点。', 64, 405, 40, 500)
    line(476)
    text('为什么？', 64, 555, 30, 600)
    ;['在没有材料提示时提取信息，', '才能检验是否真的记住。', '只看着答案觉得熟悉，', '并不等于可以独立说清楚。'].forEach((s, i) => text(s, 64, 623 + i * 49, 27))
    tag('主动提取', 64, 847, '#e4e9d4')
  } else if (questionMode && index === 3) {
    text('思考路径', 64, 153, 24, 400, '#587581')
    text('让观点经得起', 64, 258, 45, 600)
    text('进一步追问。', 64, 323, 45, 600)
    ;[['论点', '你的判断是什么？'], ['依据', '哪些事实支持它？'], ['反例', '在什么条件下不成立？']].forEach(([title, detail], i) => {
      text(title, 64, 450 + i * 144, 33, 600)
      text(detail, 64, 499 + i * 144, 26)
      line(539 + i * 144)
    })
  } else if (!questionMode && index === 0) {
    text('学习笔记', 64, 153, 24, 400, '#6b786e')
    text('记忆与学习', 64, 253, 66, 600)
    text('主动回忆，让知识重新出现。', 64, 325, 29)
    c.fillStyle = '#e8dc7e'
    c.fillRect(64, 397, 360, 48)
    text('理解，不只是反复阅读。', 77, 431, 28, 500)
    ;['不查看材料，尝试提取信息。', '在一段时间后，再次回忆。', '用反馈定位尚未理解的部分。'].forEach((s, i) => text(s, 64, 505 + i * 53, 28))
    line(680)
    text('输入', 84, 760, 26); text('回忆', 295, 760, 26); text('反馈', 513, 760, 26)
    c.strokeStyle = '#87998b'; c.lineWidth = 3
    c.beginPath(); c.moveTo(160, 750); c.lineTo(255, 750); c.moveTo(378, 750); c.lineTo(475, 750); c.stroke()
    text('PDF / 学习材料', 64, 885, 20, 400, '#69756d')
  } else if ((!questionMode && index === 1) || (questionMode && index === 4)) {
    text('内容摘要', 64, 156, 24, 400, '#6b786e')
    text('三个核心知识点', 64, 245, 49, 600)
    const items = [['主动回忆', '从记忆中主动提取信息'], ['间隔复习', '把复习分散到不同时间'], ['反馈修正', '找到遗漏，再次理解']]
    items.forEach(([title, detail], i) => {
      text(`0${i + 1}`, 64, 362 + i * 175, 26, 500, '#718775')
      text(title, 132, 362 + i * 175, 36, 600)
      text(detail, 132, 412 + i * 175, 25, 400, '#667469')
      line(461 + i * 175)
    })
  } else if (index === 2 || (questionMode && index === 0)) {
    text('知识检测 / 单选题', 64, 153, 23, 400, '#826746')
    text('哪一种做法', 64, 249, 47, 600)
    text('属于主动回忆？', 64, 315, 47, 600)
    const answers = ['反复阅读同一段材料', '合上材料，复述核心观点', '标记所有看起来重要的句子', '直接查看问题答案']
    answers.forEach((answer, i) => {
      c.fillStyle = i === 1 ? '#e4e9d4' : '#f4f0e6'
      c.fillRect(64, 385 + i * 104, 592, 78)
      text(String.fromCharCode(65 + i), 85, 435 + i * 104, 24, 600)
      text(answer, 135, 435 + i * 104, 24)
    })
    text('答案 B / 在没有提示时提取信息', 64, 885, 23, 400, '#66714f')
  } else if (index === 3 || (questionMode && index === 1)) {
    text('开放式追问', 64, 153, 24, 400, '#587581')
    text('答对了，', 64, 266, 62, 600)
    text('就理解了吗？', 64, 348, 62, 600)
    text('什么证据能支持你的判断？', 64, 465, 29)
    text('换一个情境，结论还成立吗？', 64, 518, 29)
    line(600)
    text('思考方向', 64, 680, 25, 600)
    text('尝试解释原因，而不只是重复结论。', 64, 734, 26)
    tag('迁移应用', 64, 805, '#d8e6e7')
    tag('检验假设', 249, 805, '#d8e6e7')
  } else {
    text('课程材料 / PPTX', 64, 153, 24, 400, '#826746')
    text('从阅读', 64, 250, 67, 600)
    text('到理解', 64, 339, 67, 600)
    const blocks = [140, 240, 360]
    blocks.forEach((h, i) => {
      c.fillStyle = ['#dfb29b', '#dbcf7c', '#92aaa0'][i]
      c.fillRect(78 + i * 196, 785 - h, 148, h)
      text(['阅读', '回忆', '应用'][i], 100 + i * 196, 833, 24)
    })
    text('学习路径示意', 64, 899, 20, 400, '#737c73')
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

function makeShadow() {
  const canvas = document.createElement('canvas')
  canvas.width = 256; canvas.height = 340
  const c = canvas.getContext('2d')!
  c.shadowColor = 'rgba(50, 52, 43, .25)'
  c.shadowBlur = 25; c.shadowOffsetY = 12
  c.fillStyle = '#fff'
  c.fillRect(38, 30, 180, 263)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

export function createPaperScene(host: HTMLElement, initial: SceneState): PaperSceneController {
  let state = initial
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6))
  renderer.setClearColor(0x000000, 0)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.domElement.setAttribute('aria-hidden', 'true')
  host.append(renderer.domElement)
  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 2400)
  camera.position.set(0, 0, 1200)
  scene.add(new THREE.AmbientLight(0xffffff, 1.4))
  const light = new THREE.DirectionalLight(0xfffaf0, 1.8)
  light.position.set(-400, 600, 1000)
  scene.add(light)
  const shadowTexture = makeShadow()
  const sheets: Sheet[] = []
  for (let index = 0; index < 5; index++) {
    const group = new THREE.Group()
    const geometry = new THREE.PlaneGeometry(240, 320, 18, 24)
    const positions = geometry.attributes.position
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i)
      const y = positions.getY(i)
      positions.setZ(i, Math.sin(x / 155) * 10 + Math.pow(y / 160, 2) * 5)
    }
    geometry.computeVertexNormals()
    const material = makePage(index, false)
    const questions = makePage(index, true)
    const surface = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
      map: material, roughness: .93, metalness: 0, side: THREE.DoubleSide,
    }))
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(295, 391), new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false, opacity: .63 }))
    shadow.position.set(7, -17, -16)
    group.add(shadow, surface)
    scene.add(group)
    sheets.push({ group, surface, material, questions, index })
  }

  let width = 0, height = 0, mobile = false
  let raf = 0, elapsed = 0, lastTime = 0, transition = initial.mode === 'questions' ? 1 : 0
  let gather = 0, disposed = false, visible = true, intro = initial.paused ? 1 : 0
  const pointer = new THREE.Vector2(0, 0)
  const smoothed = new THREE.Vector2(0, 0)

  function draw(delta: number) {
    if (width === 0 || height === 0) return
    const animate = !state.paused
    if (animate) elapsed += delta
    const ease = state.paused ? 1 : 1 - Math.exp(-delta * 4)
    intro += (1 - intro) * ease
    transition += ((state.mode === 'questions' ? 1 : 0) - transition) * ease
    gather += ((state.busy || state.dragging ? 1 : 0) - gather) * ease
    if (animate) smoothed.lerp(pointer, ease)
    const spacing = mobile ? Math.min(width * .33, 160) : Math.max(405, Math.min(width * .355, 660))
    const scale = mobile ? Math.min(width / 1040, .46) : Math.min(width / 1380, 1.12)
    const layouts = mobile
      ? [[-spacing, height / 2 - 271, -.2], [spacing, height / 2 - 254, .15], [0, height / 2 - 267, -.04], [spacing * .53, height / 2 - 276, .14], [-spacing * .5, height / 2 - 265, -.1]]
      : [[-spacing, height / 2 - 279, -.16], [spacing, height / 2 - 221, .15], [-spacing * .79, height / 2 - 576, .13], [spacing * .92, height / 2 - 559, -.12], [-spacing * 1.48, height / 2 - 66, .17]]
    sheets.forEach(({ group, surface, index }) => {
      const [x, y, angle] = layouts[index]
      const float = Math.sin(elapsed * .57 + index * 1.8) * (mobile ? 5 : 19)
      const shift = (index % 2 ? 1 : -1) * transition
      group.visible = !mobile || index < 3
      group.position.set(
        x * (.8 + intro * .2) + smoothed.x * (12 + index * 3) + shift * (mobile ? 3 : 24) - Math.sign(x) * gather * 30,
        y + float + (1 - intro) * (index % 2 ? -140 : 160) + smoothed.y * (6 + index * 2) + transition * (mobile ? 0 : index < 2 ? 35 : -20),
        index * 9,
      )
      group.scale.setScalar(scale * (1 - gather * .07) * (1 + transition * (mobile ? .02 : index < 2 ? .06 : -.06)))
      group.rotation.set(smoothed.y * .065 + Math.sin(elapsed * .3 + index) * .065,
        smoothed.x * .13 + Math.sin(transition * Math.PI) * .85 * (index % 2 ? 1 : -1),
        angle + Math.sin(elapsed * .34 + index) * .05 + shift * .09)
      const texture = transition > .5 ? sheets[index].questions : sheets[index].material
      if (surface.material.map !== texture) { surface.material.map = texture; surface.material.needsUpdate = true }
    })
    renderer.render(scene, camera)
  }

  function tick(time: number) {
    raf = 0
    if (disposed || !visible || document.hidden) return
    const delta = Math.min((time - lastTime) / 1000 || .016, .05)
    lastTime = time
    draw(delta)
    if (!state.paused) raf = requestAnimationFrame(tick)
  }
  function schedule() {
    if (!raf && !disposed && visible && !document.hidden) {
      lastTime = performance.now()
      raf = requestAnimationFrame(tick)
    }
  }
  function resize() {
    width = host.clientWidth; height = host.clientHeight; mobile = width < 760
    renderer.setSize(width, height)
    camera.left = -width / 2; camera.right = width / 2
    camera.top = height / 2; camera.bottom = -height / 2
    camera.updateProjectionMatrix()
    draw(.016); schedule()
  }
  function onPointer(event: PointerEvent) {
    if (state.paused || event.pointerType === 'touch') return
    const bounds = host.getBoundingClientRect()
    pointer.set((event.clientX - bounds.left) / width * 2 - 1, -((event.clientY - bounds.top) / height * 2 - 1))
    schedule()
  }
  function resetPointer() { pointer.set(0, 0) }
  function visibilityChange() {
    if (document.hidden) { cancelAnimationFrame(raf); raf = 0 } else schedule()
  }
  const observer = new ResizeObserver(resize)
  observer.observe(host)
  const intersection = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting
    if (visible) schedule(); else { cancelAnimationFrame(raf); raf = 0 }
  })
  intersection.observe(host)
  window.addEventListener('pointermove', onPointer, { passive: true })
  document.documentElement.addEventListener('pointerleave', resetPointer)
  document.addEventListener('visibilitychange', visibilityChange)
  resize()

  return {
    update(next) { state = next; if (state.paused) draw(.016); schedule() },
    dispose() {
      disposed = true; cancelAnimationFrame(raf)
      observer.disconnect(); intersection.disconnect()
      window.removeEventListener('pointermove', onPointer)
      document.documentElement.removeEventListener('pointerleave', resetPointer)
      document.removeEventListener('visibilitychange', visibilityChange)
      sheets.forEach(({ group, material, questions }) => {
        group.traverse((object) => {
          if (object instanceof THREE.Mesh) { object.geometry.dispose(); object.material.dispose() }
        })
        material.dispose(); questions.dispose()
      })
      shadowTexture.dispose(); renderer.dispose(); renderer.domElement.remove()
    },
  }
}
