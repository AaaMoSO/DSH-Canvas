/**
 * Save Image — writes the images that reached the node into the output directory named by
 * `node-canvas/config.json` (`outputDir`), following ComfyUI's SaveImage conventions:
 *
 *   <prefix>_<counter:05>_.png
 *
 * where `<prefix>` may carry a subfolder (`SD/foo`), the `%width%`/`%height%`/date placeholders
 * and a per-image `%batch_num%`. The counter continues from the files already in that folder.
 * The node passes its input images straight through, like ComfyUI's SaveImage does.
 */
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** IHDR width/height from the first bytes of a base64 PNG, or null when it is not a PNG. */
function pngSize(base64) {
  const head = Buffer.from(base64.slice(0, 64), 'base64')
  if (head.length < 24 || head[0] !== 0x89 || head[1] !== 0x50) return null
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
}

function two(value) {
  return String(value).padStart(2, '0')
}

function expandTokens(prefix, width, height, now) {
  return prefix
    .replace(/%width%/g, String(width))
    .replace(/%height%/g, String(height))
    .replace(/%year%/g, String(now.getFullYear()))
    .replace(/%month%/g, two(now.getMonth() + 1))
    .replace(/%day%/g, two(now.getDate()))
    .replace(/%hour%/g, two(now.getHours()))
    .replace(/%minute%/g, two(now.getMinutes()))
    .replace(/%second%/g, two(now.getSeconds()))
}

function splitPrefix(prefix) {
  const normalized = prefix.replace(/\\/g, '/')
  const slash = normalized.lastIndexOf('/')
  if (slash < 0) return { folder: '', base: normalized }
  return { folder: normalized.slice(0, slash), base: normalized.slice(slash + 1) }
}

/** One past the highest `<base>_<digits>_` already in the folder. */
async function nextCounter(dir, base) {
  let names
  try {
    names = await readdir(dir)
  } catch {
    return 1
  }
  const wanted = base.toLowerCase()
  let highest = 0
  for (const name of names) {
    if (name.toLowerCase().startsWith(wanted + '_') !== true) continue
    const digits = name.slice(base.length + 1).split('_')[0].split('.')[0]
    const value = Number(digits)
    if (Number.isInteger(value) && value > highest) highest = value
  }
  return highest + 1
}

export async function run(inputs, ctx) {
  const configured = String(ctx.config?.outputDir ?? '')
  if (configured === '') throw new Error('node-canvas/config.json 缺少 outputDir')
  const images = Array.isArray(inputs.images?.images_b64) ? inputs.images.images_b64 : []
  if (images.length === 0) throw new Error('没有可保存的图片')
  const size = pngSize(images[0])
  if (size === null) throw new Error('图片数据不是 PNG')

  const raw = String(inputs.filename_prefix ?? '') || 'ComfyUI'
  const { folder, base } = splitPrefix(expandTokens(raw, size.width, size.height, new Date()))

  // A prefix must not escape the output directory.
  const outputDir = path.resolve(configured)
  const dir = path.resolve(outputDir, folder)
  const relative = path.relative(outputDir, dir)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('拒绝写入输出目录之外：' + folder)
  }
  await mkdir(dir, { recursive: true })

  let counter = await nextCounter(dir, base)
  const written = []
  for (const [index, b64] of images.entries()) {
    if (typeof b64 !== 'string' || b64 === '') throw new Error('图片数据不是 base64 字符串')
    const name = base.replace(/%batch_num%/g, String(index))
      + '_' + String(counter).padStart(5, '0') + '_.png'
    counter += 1
    await writeFile(path.join(dir, name), Buffer.from(b64, 'base64'))
    const shown = folder === '' ? name : folder + '/' + name
    written.push(shown)
    ctx.log('saved ' + shown)
  }
  return [inputs.images]
}
