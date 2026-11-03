#!/usr/bin/env node
/**
 * Derive build/icon.ico and build/icon.icns from build/app-icon.png.
 *
 * Runs on every platform: rasterising uses `sharp` (already a dependency)
 * instead of macOS-only `sips`. The `.icns` path still prefers `iconutil` when
 * it is available, because that is the canonical encoder; elsewhere the
 * container is written directly with PNG payloads, which macOS reads natively.
 */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const sharp = require('sharp')

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const buildDirectory = path.join(projectRoot, 'build')
const source = path.join(buildDirectory, 'app-icon.png')
const icnsDestination = path.join(buildDirectory, 'icon.icns')
const icoDestination = path.join(buildDirectory, 'icon.ico')

const raster = async (size) =>
  sharp(source)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()

const hasIconutil = (() => {
  try {
    execFileSync('iconutil', ['--help'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

/* ------------------------------------------------------------------ *
 * .icns
 * ------------------------------------------------------------------ */

/**
 * PNG-capable ICNS chunk types.
 *
 * `icp4`–`icp6` predate the PNG container and are nominally 24-bit RGB or
 * JPEG-2000, so only the `ic07`–`ic14` family is used here: every one of those
 * is defined as PNG and is what current macOS reads for app icons.
 */
const ICNS_TYPES = [
  ['ic07', 128],
  ['ic13', 256], // 128@2x
  ['ic08', 256],
  ['ic14', 512], // 256@2x
  ['ic09', 512],
  ['ic10', 1024] // 512@2x
]

async function writeIcnsDirect() {
  const chunks = []
  for (const [type, size] of ICNS_TYPES) {
    const png = await raster(size)
    const header = Buffer.alloc(8)
    header.write(type, 0, 'ascii')
    header.writeUInt32BE(png.length + 8, 4)
    chunks.push(header, png)
  }
  const body = Buffer.concat(chunks)
  const header = Buffer.alloc(8)
  header.write('icns', 0, 'ascii')
  header.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([header, body])
}

async function writeIcnsViaIconutil() {
  const iconset = path.join(buildDirectory, 'app-icon.iconset')
  await rm(iconset, { recursive: true, force: true })
  await mkdir(iconset, { recursive: true })
  for (const size of [16, 32, 128, 256, 512]) {
    await writeFile(path.join(iconset, `icon_${size}x${size}.png`), await raster(size))
    await writeFile(path.join(iconset, `icon_${size}x${size}@2x.png`), await raster(size * 2))
  }
  try {
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', icnsDestination])
  } finally {
    await rm(iconset, { recursive: true, force: true })
  }
}

if (hasIconutil) {
  await writeIcnsViaIconutil()
} else {
  await writeFile(icnsDestination, await writeIcnsDirect())
}

/* ------------------------------------------------------------------ *
 * .ico — hand-assembled container; PNG payloads are valid from Vista on.
 * ------------------------------------------------------------------ */

const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const images = []
for (const size of icoSizes) images.push(await raster(size))

const header = Buffer.alloc(6 + images.length * 16)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(images.length, 4)

let offset = header.length
for (let index = 0; index < images.length; index += 1) {
  const size = icoSizes[index]
  const entry = 6 + index * 16
  header.writeUInt8(size === 256 ? 0 : size, entry) // 0 means 256
  header.writeUInt8(size === 256 ? 0 : size, entry + 1)
  header.writeUInt8(0, entry + 2) // palette entries
  header.writeUInt8(0, entry + 3) // reserved
  header.writeUInt16LE(1, entry + 4) // colour planes
  header.writeUInt16LE(32, entry + 6) // bits per pixel
  header.writeUInt32LE(images[index].length, entry + 8)
  header.writeUInt32LE(offset, entry + 12)
  offset += images[index].length
}

await writeFile(icoDestination, Buffer.concat([header, ...images]))

const sourcePng = await readFile(source)
console.log(
  `Generated app icons from ${path.relative(projectRoot, source)} (${sourcePng.length} bytes PNG).`
)
console.log(`  icon.ico  ${ icoSizes.join('/') } px`)
console.log(`  icon.icns via ${hasIconutil ? 'iconutil' : 'direct PNG container'}`)
