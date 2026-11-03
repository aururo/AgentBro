/**
 * 生成 build/agentbro-wordmark.svg —— AgentBro 文字字标。
 *
 * 背景：上游 `@deepseek-ai/dsh-client-ui-primitives` 的 `BrandWordmark` 是硬编码的
 * "DeepSeek" 字形路径，无法通过改字符串替换，因此侧边栏品牌名必须自绘。
 * 本脚本的产物与上游字标同规格：24 单位画布、cap 高 14、基线 18.6、单色 currentColor，
 * 侧边栏以 24px 盒高渲染时与上游光学尺寸一致。
 *
 * 字体：Inter SemiBold（`scripts/fonts/inter-latin-600-normal.woff2`），
 * 授权 SIL Open Font License 1.1，见 `scripts/fonts/Inter-OFL.txt`。
 * 文字已转曲为路径，运行期不需要字体文件。
 *
 * 依赖：`fontkit`（仓库内为传递依赖，随 `@deepseek-ai/dsh-skill-office` 安装）。
 * 该耦合与 `sharp` 同类，记录在 agentbro/README.md 的「已知耦合」。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const fontkit = require('fontkit')

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fontFile = path.join(projectRoot, 'scripts', 'fonts', 'inter-latin-600-normal.woff2')
const outputFile = path.join(projectRoot, 'build', 'agentbro-wordmark.svg')

/** 字标文本。与产品显示名一致，不含标点。 */
const TEXT = 'AgentBro'
/** 画布高度，与上游 BrandWordmark 的 viewBox 高度一致。 */
const BOX_HEIGHT = 24
/** 目标 cap 高（首字母 A 的大写字高）。上游字标实测 14.1。 */
const TARGET_CAP_HEIGHT = 14
/** 目标基线位置（y 轴向下）。上游字标实测 18.7。 */
const TARGET_BASELINE = 18.6
/** 字距，单位 em。上游侧边栏品牌名为 .04em，字标自身取 -0.01em。 */
const LETTER_SPACING_EM = -0.01

const font = fontkit.create(readFileSync(fontFile))
const unitsPerEm = font.unitsPerEm
const capHeight = font.capHeight
if (!capHeight) throw new Error('Font does not expose a cap height.')

/** 字体单位 → SVG 单位的缩放比。 */
const scale = TARGET_CAP_HEIGHT / capHeight
/** 等效字号（SVG 单位），字距按它换算。 */
const fontSize = scale * unitsPerEm
const letterSpacing = LETTER_SPACING_EM * fontSize

const run = font.layout(TEXT)
if (run.glyphs.length !== TEXT.length) {
  throw new Error(`Expected ${TEXT.length} glyphs, got ${run.glyphs.length}.`)
}

/**
 * 按固定顺序遍历字形，累进位距。
 *
 * @param {(glyph: object, position: object, cursor: number) => void} visit
 */
function eachGlyph(visit) {
  let cursor = 0
  for (let index = 0; index < run.glyphs.length; index += 1) {
    const glyph = run.glyphs[index]
    const position = run.positions[index]
    visit(glyph, position, cursor)
    cursor += position.xAdvance * scale
    if (index < run.glyphs.length - 1) cursor += letterSpacing
  }
}

// 第一趟：量墨迹包围盒（fontkit 的 bbox 已包含曲线控制点，对字形足够）。
let inkX1 = Infinity
let inkY1 = Infinity
let inkX2 = -Infinity
let inkY2 = -Infinity
eachGlyph((glyph, position, cursor) => {
  const box = glyph.path.bbox
  const originX = cursor + position.xOffset * scale
  if (originX + box.minX * scale < inkX1) inkX1 = originX + box.minX * scale
  if (originX + box.maxX * scale > inkX2) inkX2 = originX + box.maxX * scale
  if (TARGET_BASELINE - box.maxY * scale < inkY1) inkY1 = TARGET_BASELINE - box.maxY * scale
  if (TARGET_BASELINE - box.minY * scale > inkY2) inkY2 = TARGET_BASELINE - box.minY * scale
})

// 第二趟：平移到墨迹左缘贴 x=0，写出路径。
const offsetX = -inkX1
const parts = []
eachGlyph((glyph, position, cursor) => {
  // 字体坐标 y 轴向上，SVG y 轴向下：翻转 y 并把基线搬到 TARGET_BASELINE。
  const path = glyph.path.transform(
    scale, 0,
    0, -scale,
    cursor + position.xOffset * scale + offsetX, TARGET_BASELINE
  )
  parts.push(path.toSVG())
})

const wordmarkPath = parts.join('')
const width = Math.ceil((inkX2 - inkX1) * 100) / 100

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<!--
  AgentBro 字标。"AgentBro" 以 Inter SemiBold (SIL OFL 1.1) 转曲为路径，
  规格对齐上游 BrandWordmark：${BOX_HEIGHT} 单位画布、cap 高 ${TARGET_CAP_HEIGHT}、基线 ${TARGET_BASELINE}。
  单色 currentColor，侧边栏深浅主题共用；运行时不需要字体文件。
  由 scripts/generate-wordmark.mjs 生成，勿手改。
-->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${BOX_HEIGHT}" fill="none" aria-hidden="true">
  <path d="${wordmarkPath}" fill="currentColor"/>
</svg>
`

writeFileSync(outputFile, svg, 'utf8')

console.log(`Wordmark written: ${path.relative(projectRoot, outputFile)}`)
console.log(`  text         = ${TEXT}`)
console.log(`  font         = ${font.familyName} (unitsPerEm=${unitsPerEm}, capHeight=${capHeight})`)
console.log(`  cap height   = ${capHeight} -> ${TARGET_CAP_HEIGHT} (scale ${scale.toFixed(6)})`)
console.log(`  ink bbox     = x ${inkX1.toFixed(2)}..${inkX2.toFixed(2)}  y ${inkY1.toFixed(2)}..${inkY2.toFixed(2)}`)
console.log(`  viewBox      = 0 0 ${width} ${BOX_HEIGHT}`)
console.log(`  path length  = ${wordmarkPath.length} chars`)
