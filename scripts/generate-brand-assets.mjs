#!/usr/bin/env node
/**
 * Single source of truth for the AgentBro brand mark.
 *
 * Every bitmap and vector the app ships is derived from the geometry below, so
 * the icon, the favicon, the runtime logos and the in-app sidebar mark can
 * never drift apart. Edit the numbers here and re-run; do not hand-edit
 * build/*.png, build/brand-mark.svg or the copies under docs/images.
 *
 * The geometry is a measured reconstruction of the reference artwork: the
 * source drawing was rasterised, every row scanned for ink runs, and each part
 * traced back to its pixel bounds. Coordinates below are stated in the
 * reference's own pixel space and scaled by `SCALE` into the 1000x1000 canvas,
 * which keeps the numbers diffable against the reference.
 *
 * Usage:
 *   node scripts/generate-brand-assets.mjs            # writes build/
 *   node scripts/generate-brand-assets.mjs --preview  # also writes docs/images/brand-preview/
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const sharp = require('sharp')

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const buildDirectory = path.join(projectRoot, 'build')
const previewDirectory = path.join(projectRoot, 'docs', 'images', 'brand-preview')
const wantPreview = process.argv.includes('--preview')

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

/** Reference artwork is 79x63; 13.5 puts the 44px-wide head at 594/1000. */
const SCALE = 13.5
/** Head frame spans x 17..61 in the reference, so its centre is 39. */
const HEAD_CENTER_X = 39
/** Whole-mark bounding box spans y 2..56, centred on 29. */
const MARK_CENTER_Y = 29
/** Design-canvas centre the head is anchored to. */
const CANVAS = 500

const X = (v) => CANVAS + (v - HEAD_CENTER_X) * SCALE
const Y = (v) => CANVAS + (v - MARK_CENTER_Y) * SCALE
const L = (v) => v * SCALE
const round = (v) => Math.round(v * 100) / 100

const GEOMETRY = {
  // Head: 44x34 outline with a 4px stroke. The stroke is drawn as two
  // sub-paths (outer + inner) carved out with fill-rule=evenodd, not as an
  // SVG stroke, because the mark has to stay a single filled path.
  head: { x: X(17), y: Y(8), w: L(44), h: L(34), r: L(5), stroke: L(4) },
  // Bump on top of the head. Merged into the head outline path: under
  // evenodd, any two overlapping sub-paths cancel out, so it cannot be a
  // separate shape that overlaps the frame.
  bump: { w: L(10), h: L(6), r: L(2.4), fillet: L(0.4) },
  // Eyes. Deliberately off-centre: in the reference the two eyes sit right of
  // the screen's midpoint (left margin 12, gap 6, right margin 5 out of 36),
  // which reads as a sideways glance and is part of the character.
  eye: { w: L(6.4), h: L(11.6), r: L(3.2), span: L(12.5), offset: L(3), cy: 416 },
  // Torso with a notch cut up from the bottom edge to split the legs. The
  // notch is widened from the reference's 2px: below ~3px equivalent it
  // disappears at 32px and the legs read as one block.
  body: {
    x: X(29.5), y: Y(42), w: L(19), h: L(14),
    rt: L(1.5), rb: L(2.5), notchW: L(2.8), notchD: L(7), rn: L(0.8)
  },
  // Left arm hangs down, right arm extends sideways. The asymmetry is the
  // pose; only the gap between arm and torso differs from side to side.
  armLeft: { x: X(20), y: Y(43), w: L(7.3), h: L(11.5) },
  armRight: { x: X(49.5), y: Y(43), w: L(12), h: L(7.5) }
}

/* ------------------------------------------------------------------ *
 * Path builders
 * ------------------------------------------------------------------ */

/** Rounded rectangle as a sub-path. `r` is clamped to half the short side. */
function roundedRect(x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2)
  const x2 = x + w
  const y2 = y + h
  return `M${round(x + radius)} ${round(y)}`
    + `H${round(x2 - radius)}`
    + `A${round(radius)} ${round(radius)} 0 0 1 ${round(x2)} ${round(y + radius)}`
    + `V${round(y2 - radius)}`
    + `A${round(radius)} ${round(radius)} 0 0 1 ${round(x2 - radius)} ${round(y2)}`
    + `H${round(x + radius)}`
    + `A${round(radius)} ${round(radius)} 0 0 1 ${round(x)} ${round(y2 - radius)}`
    + `V${round(y + radius)}`
    + `A${round(radius)} ${round(radius)} 0 0 1 ${round(x + radius)} ${round(y)}Z`
}

/**
 * Head outline: rounded square with the bump traced into the same closed
 * contour (up the bump's left side, over its top, back down to the top edge).
 * Splitting it into a separate `roundedRect` would let evenodd cancel the
 * overlap and punch a hole through the head.
 */
function headOutline(x, y, w, h, r, bumpW, bumpH, bumpR, fillet) {
  const x2 = x + w
  const y2 = y + h
  const left = x + (w - bumpW) / 2
  const right = left + bumpW
  const top = y - bumpH
  return `M${round(x + r)} ${round(y)}`
    + `H${round(left + fillet)}`
    + `A${round(fillet)} ${round(fillet)} 0 0 0 ${round(left)} ${round(y - fillet)}`
    + `V${round(top + bumpR)}`
    + `A${round(bumpR)} ${round(bumpR)} 0 0 1 ${round(left + bumpR)} ${round(top)}`
    + `H${round(right - bumpR)}`
    + `A${round(bumpR)} ${round(bumpR)} 0 0 1 ${round(right)} ${round(top + bumpR)}`
    + `V${round(y - fillet)}`
    + `A${round(fillet)} ${round(fillet)} 0 0 0 ${round(right + fillet)} ${round(y)}`
    + `H${round(x2 - r)}`
    + `A${round(r)} ${round(r)} 0 0 1 ${round(x2)} ${round(y + r)}`
    + `V${round(y2 - r)}`
    + `A${round(r)} ${round(r)} 0 0 1 ${round(x2 - r)} ${round(y2)}`
    + `H${round(x + r)}`
    + `A${round(r)} ${round(r)} 0 0 1 ${round(x)} ${round(y2 - r)}`
    + `V${round(y + r)}`
    + `A${round(r)} ${round(r)} 0 0 1 ${round(x + r)} ${round(y)}Z`
}

/** Torso with a rounded notch rising from the bottom edge to split the legs. */
function torso(x, y, w, h, rt, rb, notchW, notchD, rn) {
  const x2 = x + w
  const y2 = y + h
  const notchLeft = x + (w - notchW) / 2
  const notchRight = notchLeft + notchW
  const notchTop = y2 - notchD
  return `M${round(x + rt)} ${round(y)}`
    + `H${round(x2 - rt)}`
    + `A${round(rt)} ${round(rt)} 0 0 1 ${round(x2)} ${round(y + rt)}`
    + `V${round(y2 - rb)}`
    + `A${round(rb)} ${round(rb)} 0 0 1 ${round(x2 - rb)} ${round(y2)}`
    + `H${round(notchRight + rn)}`
    + `A${round(rn)} ${round(rn)} 0 0 1 ${round(notchRight)} ${round(y2 - rn)}`
    + `V${round(notchTop + rn)}`
    + `A${round(rn)} ${round(rn)} 0 0 0 ${round(notchRight - rn)} ${round(notchTop)}`
    + `H${round(notchLeft + rn)}`
    + `A${round(rn)} ${round(rn)} 0 0 0 ${round(notchLeft)} ${round(notchTop + rn)}`
    + `V${round(y2 - rn)}`
    + `A${round(rn)} ${round(rn)} 0 0 1 ${round(notchLeft - rn)} ${round(y2)}`
    + `H${round(x + rb)}`
    + `A${round(rb)} ${round(rb)} 0 0 1 ${round(x)} ${round(y2 - rb)}`
    + `V${round(y + rt)}`
    + `A${round(rt)} ${round(rt)} 0 0 1 ${round(x + rt)} ${round(y)}Z`
}

/* ------------------------------------------------------------------ *
 * The mark
 * ------------------------------------------------------------------ */

const { head, bump, eye, body, armLeft, armRight } = GEOMETRY

const screen = {
  x: head.x + head.stroke,
  y: head.y + head.stroke,
  w: head.w - head.stroke * 2,
  h: head.h - head.stroke * 2,
  r: L(2)
}

const eyeLeftX = CANVAS + eye.offset - eye.span / 2 - eye.w / 2
const eyeRightX = CANVAS + eye.offset + eye.span / 2 - eye.w / 2
const eyeY = eye.cy - eye.h / 2

/** Seven sub-paths, one `d`. Downstream code treats it as a single path. */
const MARK_PATH = headOutline(
  head.x, head.y, head.w, head.h, head.r, bump.w, bump.h, bump.r, bump.fillet
)
  + roundedRect(screen.x, screen.y, screen.w, screen.h, screen.r)
  + roundedRect(eyeLeftX, eyeY, eye.w, eye.h, eye.r)
  + roundedRect(eyeRightX, eyeY, eye.w, eye.h, eye.r)
  + torso(body.x, body.y, body.w, body.h, body.rt, body.rb, body.notchW, body.notchD, body.rn)
  + roundedRect(armLeft.x, armLeft.y, armLeft.w, armLeft.h, armLeft.w / 2)
  + roundedRect(armRight.x, armRight.y, armRight.w, armRight.h, armRight.h / 2)

/** Tight bounds of the mark inside the 1000x1000 artwork. */
const MARK_VIEWBOX = {
  x: head.x,
  y: Y(2),
  width: armRight.x + armRight.w - head.x,
  height: Y(56) - Y(2)
}
const MARK_CENTER = {
  x: round(MARK_VIEWBOX.x + MARK_VIEWBOX.width / 2),
  y: round(MARK_VIEWBOX.y + MARK_VIEWBOX.height / 2)
}

export const BRAND = { MARK_PATH, MARK_VIEWBOX, MARK_CENTER }

/* ------------------------------------------------------------------ *
 * Artwork wrappers
 * ------------------------------------------------------------------ */

const INK = '#1c1c1e'
const PAPER = '#ffffff'
const BRAND_BLUE = '#4b6bff'
const LIGHT_BG = '#fbfbfd'

/** The mark, anchored on its bounding-box centre inside a 1024 canvas. */
const placedMark = (fg, scale) => `<g transform="translate(512 512) scale(${scale}) `
  + `translate(${-MARK_CENTER.x} ${-MARK_CENTER.y})">`
  + `<path fill="${fg}" fill-rule="evenodd" clip-rule="evenodd" d="${MARK_PATH}"/></g>`

/** 336x192 theme logo: both arms included, the mark is not cropped. */
const logoSvg = (fg) => `<svg xmlns="http://www.w3.org/2000/svg" width="336" height="192" viewBox="0 0 336 192" fill="none">
<g transform="translate(168 96) scale(0.241) translate(${-MARK_CENTER.x} ${-MARK_CENTER.y})"><path fill="${fg}" fill-rule="evenodd" clip-rule="evenodd" d="${MARK_PATH}"/></g>
</svg>
`

const tileSvg = (bg, fg, scale) => `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" fill="none">
<rect x="100" y="100" width="824" height="824" rx="182" fill="${bg}"/>
${placedMark(fg, scale)}
</svg>
`

const flatSvg = (bg, fg, scale) => `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" fill="none">
<rect width="1024" height="1024" fill="${bg}"/>
${placedMark(fg, scale)}
</svg>
`

const svgToPng = async (svg, width, height = width, { opaque } = {}) => {
  const pipeline = sharp(Buffer.from(svg), { density: 600 })
    .resize(width, height, { fit: 'fill' })
  if (opaque) pipeline.flatten({ background: opaque }).removeAlpha()
  return pipeline.png().toBuffer()
}

/* ------------------------------------------------------------------ *
 * Emit
 * ------------------------------------------------------------------ */

await mkdir(buildDirectory, { recursive: true })

await writeFile(
  path.join(buildDirectory, 'brand-mark.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000" viewBox="0 0 1000 1000" fill="none">
<path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="${MARK_PATH}"/>
</svg>
`
)

// App icon: transparent 1024 with the rounded tile, matching the Apple grid
// (824px tile, 100px margins). electron-builder derives icns/ico from it.
await writeFile(
  path.join(buildDirectory, 'app-icon.png'),
  await svgToPng(tileSvg(INK, PAPER, 0.92), 1024)
)

// Runtime icon / favicon / manifest icon: opaque 1254 on the light backdrop.
await writeFile(
  path.join(buildDirectory, 'icon.png'),
  await svgToPng(flatSvg(LIGHT_BG, BRAND_BLUE, 0.96), 1254, 1254, { opaque: LIGHT_BG })
)

// Theme-aware logos for the pairing page and about surfaces.
await writeFile(
  path.join(buildDirectory, 'logo-light.png'),
  await svgToPng(logoSvg(INK), 336, 192)
)
await writeFile(
  path.join(buildDirectory, 'logo-dark.png'),
  await svgToPng(logoSvg(PAPER), 336, 192)
)

/* ------------------------------------------------------------------ *
 * Optional preview sheet
 * ------------------------------------------------------------------ */

if (wantPreview) {
  await mkdir(previewDirectory, { recursive: true })
  const write = async (name, svg, width, height, options) =>
    writeFile(path.join(previewDirectory, name), await svgToPng(svg, width, height, options))

  await write('agentbro-icon-1024.png', tileSvg(INK, PAPER, 0.92), 1024)
  await write('agentbro-icon-512.png', tileSvg(INK, PAPER, 0.92), 512)
  await write('agentbro-icon-128.png', tileSvg(INK, PAPER, 0.92), 128)
  await write('agentbro-icon-64.png', tileSvg(INK, PAPER, 0.92), 64)
  await write('agentbro-icon-32.png', tileSvg(INK, PAPER, 0.92), 32)
  await write('agentbro-icon-16.png', tileSvg(INK, PAPER, 0.92), 16)
  await write('agentbro-icon-1254.png', flatSvg(LIGHT_BG, BRAND_BLUE, 0.96), 1254, 1254, { opaque: LIGHT_BG })
  await write('agentbro-logo-light.png', logoSvg(INK), 336, 192)
  await write('agentbro-logo-dark.png', logoSvg(PAPER), 336, 192)
  await write('mark-on-light.png', flatSvg(PAPER, INK, 0.92), 336, 336, { opaque: PAPER })
  await write('mark-on-dark.png', flatSvg('#0d0d0f', PAPER, 0.92), 336, 336, { opaque: '#0d0d0f' })
  await writeFile(
    path.join(previewDirectory, 'agentbro-mark.svg'),
    `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000" viewBox="0 0 1000 1000" fill="none">
<path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="${MARK_PATH}"/>
</svg>
`
  )
  await writeFile(path.join(previewDirectory, 'agentbro-icon.svg'), tileSvg(INK, PAPER, 0.92))
  await writeFile(path.join(previewDirectory, 'agentbro-icon-light.svg'), flatSvg(LIGHT_BG, BRAND_BLUE, 0.96))

  /* One-page contact sheet: tiles, theme logos and the small-size strip. */
  const W = 1200
  const H = 660
  const place = async (file, left, top, width, height, background) => {
    const buf = await sharp(path.join(previewDirectory, file))
      .resize(width, height, { fit: 'contain', background })
      .png().toBuffer()
    return { input: buf, left, top }
  }
  const white = { r: 255, g: 255, b: 255, alpha: 1 }
  const clear = { r: 0, g: 0, b: 0, alpha: 0 }
  const layers = [
    await place('mark-on-light.png', 40, 70, 200, 200, white),
    await place('agentbro-icon-512.png', 300, 55, 230, 230, clear),
    await place('agentbro-icon-1254.png', 580, 55, 230, 230, clear),
    await place('agentbro-logo-light.png', 40, 390, 240, 137, white),
    await place('mark-on-dark.png', 330, 360, 200, 200, clear)
  ]
  let stripX = 620
  for (const size of [128, 64, 32, 16]) {
    layers.push(await place(`agentbro-icon-${size}.png`, stripX, 395 + Math.round((128 - size) / 2), size, size, clear))
    stripX += size + 26
  }
  const label = (x, y, text) =>
    `<text x="${x}" y="${y}" font-family="Segoe UI,Microsoft YaHei,sans-serif" font-size="13" fill="#6b6b73">${text}</text>`
  const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<rect width="${W}" height="${H}" fill="#f2f2f5"/>
<text x="40" y="42" font-family="Segoe UI,Microsoft YaHei,sans-serif" font-size="22" font-weight="600" fill="#1c1c1e">AgentBro brand mark</text>
${label(40, 320, 'mono mark · light')}
${label(300, 320, 'app-icon.png · 1024 · dark tile')}
${label(580, 320, 'icon.png · 1254 · brand blue')}
${label(40, 578, 'logo-light.png · 336x192')}
${label(330, 598, 'mono mark · dark')}
${label(620, 598, '128 / 64 / 32 / 16')}
${label(40, 638, `single path · 7 sub-paths · fill-rule=evenodd · tight bounds ${MARK_VIEWBOX.width}x${MARK_VIEWBOX.height} at ${MARK_VIEWBOX.x},${MARK_VIEWBOX.y}`)}
</svg>`
  await sharp({ create: { width: W, height: H, channels: 4, background: '#f2f2f5' } })
    .composite([{ input: Buffer.from(overlay), left: 0, top: 0 }, ...layers])
    .png().toFile(path.join(previewDirectory, 'agentbro-sheet.png'))
}

const relative = (file) => path.relative(projectRoot, file)
console.log(`Brand mark: ${MARK_PATH.length} chars, ${(MARK_PATH.match(/M/gu) ?? []).length} sub-paths`)
console.log(`Tight bounds: x ${MARK_VIEWBOX.x} y ${MARK_VIEWBOX.y} ${MARK_VIEWBOX.width}x${MARK_VIEWBOX.height}`)
console.log(`Wrote ${[
  'brand-mark.svg', 'app-icon.png', 'icon.png', 'logo-light.png', 'logo-dark.png'
].map((file) => relative(path.join(buildDirectory, file))).join(', ')}`)
