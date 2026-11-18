/**
 * sd.cpp Load Model — starts `sd-server.exe` when it is not up, then asks it to load a recipe
 * plus the chosen model files.
 *
 * Machine-level settings (where sd.cpp lives, which port the server listens on) belong to
 * `node-canvas/config.json`, not to the node: the node only picks the recipe placement and files.
 */
import { spawn, execFile } from 'node:child_process'
import { closeSync, existsSync, openSync } from 'node:fs'
import path from 'node:path'

const PLACEMENT_SUFFIX = {
  'gpu (diffusion on CUDA, TE in RAM)': '-gpu',
  all_gpu: '',
  'all_cpu (weights in RAM)': '-ram',
  'recipe decides placement': '',
}

const READY_TIMEOUT = 300_000
const LOAD_TIMEOUT = 900_000

function baseUrl(ctx) {
  return 'http://127.0.0.1:' + (Number(ctx.config?.sdCppPort) || 8288)
}

async function request(ctx, method, pathName, body, timeoutMs) {
  const signals = [ctx.signal]
  if (timeoutMs !== undefined) signals.push(AbortSignal.timeout(timeoutMs))
  const response = await fetch(baseUrl(ctx) + pathName, {
    method,
    headers: body === undefined
      ? { accept: 'application/json' }
      : { accept: 'application/json', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.any(signals),
  })
  const text = await response.text()
  if (response.ok !== true) {
    throw new Error('sd-server ' + method + ' ' + pathName + ' -> HTTP ' + response.status + ': ' + text.slice(0, 800))
  }
  return text.trim() === '' ? {} : JSON.parse(text)
}

async function isUp(ctx) {
  try {
    await request(ctx, 'GET', '/sdcpp/v1/models/status', undefined, 3000)
    return true
  } catch {
    return false
  }
}

async function ensureServer(ctx, root) {
  if (await isUp(ctx)) return
  const port = String(Number(ctx.config?.sdCppPort) || 8288)
  const exe = path.join(root, 'bin', 'sd-server.exe')
  if (existsSync(exe) !== true) throw new Error('找不到 ' + exe)
  // Extra flags from config.json, e.g. ["--vae-tiling"] or ["--max-vram", "5.6"].
  const extra = Array.isArray(ctx.config?.sdServerArgs)
    ? ctx.config.sdServerArgs.filter((value) => typeof value === 'string')
    : []
  // The upscale endpoint resolves names from this catalog; without it `/upscale` only fails.
  const upscaleDir = path.join(root, 'models', 'upscale_models')
  const upscaleArgs = existsSync(upscaleDir) ? ['--hires-upscalers-dir', upscaleDir] : []
  ctx.log('starting sd-server on port ' + port + (extra.length === 0 ? '' : ' (' + extra.join(' ') + ')'))
  let spawnError
  // The server writes its own diagnostics (missing model, VRAM, backend) to stdout; without a
  // log file a failed load is just "fetch failed".
  const logFile = path.join(root, 'sd-server.log')
  const logHandle = openSync(logFile, 'a')
  const child = spawn(exe, [
    '--model-dir', path.join(root, 'models'),
    '--listen-ip', '127.0.0.1',
    '--listen-port', port,
    ...upscaleArgs,
    ...extra,
  ], { cwd: root, detached: true, stdio: ['ignore', logHandle, logHandle], windowsHide: true })
  closeSync(logHandle)
  // Without this listener a missing DLL or a bad path becomes an uncaught 'error' event.
  child.on('error', (error) => {
    spawnError = error
  })
  child.unref()
  const deadline = Date.now() + READY_TIMEOUT
  while (Date.now() < deadline) {
    if (spawnError !== undefined) throw new Error('sd-server 启动失败：' + spawnError.message)
    if (await isUp(ctx)) {
      ctx.log('sd-server ready')
      return
    }
    if (child.exitCode !== null) throw new Error('sd-server exited immediately (code ' + child.exitCode + ')')
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('sd-server 在 ' + READY_TIMEOUT / 1000 + ' 秒内未就绪')
}

/** A recipe file that actually exists: the requested one, else the placement variants. */
function pickRecipe(ctx, root, base, placement) {
  const wanted = base + (PLACEMENT_SUFFIX[placement] ?? '')
  if (existsSync(path.join(root, 'models', 'recipes', wanted + '.json'))) return wanted
  for (const suffix of ['-gpu', '-ram']) {
    const candidate = base + suffix
    if (existsSync(path.join(root, 'models', 'recipes', candidate + '.json'))) {
      ctx.log('recipe ' + wanted + ' not found, using ' + candidate)
      return candidate
    }
  }
  return wanted
}

/** Kill whatever sd-server is listening; a wedged server answers /models/status but not /load. */
function killServer() {
  return new Promise((resolve) => {
    execFile('taskkill', ['/IM', 'sd-server.exe', '/F'], { windowsHide: true }, () => resolve())
  })
}

async function restartServer(ctx, root) {
  ctx.log('sd-server 无响应，重启中')
  await killServer()
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if ((await isUp(ctx)) !== true) break
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  await ensureServer(ctx, root)
}

export async function run(inputs, ctx) {
  const root = String(ctx.config?.sdCppRoot ?? '')
  if (root === '') throw new Error('node-canvas/config.json 缺少 sdCppRoot')

  // One sd-server holds one model context, so a workflow owns it until its run ends; a second
  // workflow queues here instead of swapping the model underneath the first.
  const release = typeof ctx.lock === 'function' ? await ctx.lock('sd-server') : () => {}
  if (release === null) throw new Error('已取消')
  if (typeof ctx.onRunEnd === 'function') ctx.onRunEnd(release)

  const recipeBase = String(inputs.recipe ?? '') || 'z-image-turbo'
  const placement = String(inputs.placement ?? '') || 'gpu (diffusion on CUDA, TE in RAM)'
  const recipe = pickRecipe(ctx, root, recipeBase, placement)
  const vae = String(inputs.vae ?? '').trim() !== '' ? String(inputs.vae) : String(inputs.vae_name ?? '')
  // The recipe slot for the text encoder is called `llm`; sd.cpp rejects the load otherwise.
  const models = {
    diffusion_model: String(inputs.diffusion_model ?? ''),
    llm: String(inputs.text_encoder ?? ''),
    vae,
  }
  const vision = String(inputs.vision_encoder ?? '')
  if (vision !== '' && vision !== '(none)') models.llm_vision = vision

  await ensureServer(ctx, root)
  ctx.log('load recipe=' + recipe)
  const started = Date.now()
  let result
  try {
    result = await request(ctx, 'POST', '/sdcpp/v1/models/load', { recipe, models }, LOAD_TIMEOUT)
  } catch (error) {
    const message = String(error?.message ?? '')
    // A wedged server still answers the status probe, so the only way out is a fresh process.
    if (message.includes('HTTP') !== true && /fetch failed|ECONN|socket|timeout/i.test(message)) {
      await restartServer(ctx, root)
      result = await request(ctx, 'POST', '/sdcpp/v1/models/load', { recipe, models }, LOAD_TIMEOUT)
    } else if (message.includes('unknown recipe') === true) {
      // A recipe written after the server started is not in its catalog yet.
      ctx.log('recipe not in catalog, refreshing')
      await request(ctx, 'POST', '/sdcpp/v1/models/refresh', {}, 120_000)
      result = await request(ctx, 'POST', '/sdcpp/v1/models/load', { recipe, models }, LOAD_TIMEOUT)
    } else {
      throw error
    }
  }
  ctx.log('loaded in ' + ((Date.now() - started) / 1000).toFixed(1) + 's')
  return [{ base_recipe: recipeBase, recipe, models, placement }]
}
