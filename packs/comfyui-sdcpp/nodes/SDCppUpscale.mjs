/**
 * sd.cpp Upscale — ESRGAN through `POST /sdcpp/v1/upscale`, which runs synchronously and does
 * not touch the diffusion model. `repeats` multiplies the model's own scale (x4 for the usual
 * RealESRGAN weights), `tile_size` bounds the memory used per pass.
 */
const UPSCALE_TIMEOUT = 1_800_000

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

export async function run(inputs, ctx) {
  // Upscaling runs on the same server as sampling; keep the workflow's claim on it.
  const release = typeof ctx.lock === 'function' ? await ctx.lock('sd-server') : () => {}
  if (release === null) throw new Error('已取消')
  if (typeof ctx.onRunEnd === 'function') ctx.onRunEnd(release)

  const images = Array.isArray(inputs.image?.images_b64) ? inputs.image.images_b64 : []
  if (images.length === 0) throw new Error('没有可放大的图片')
  const upscaler = String(inputs.upscaler ?? '')
  if (upscaler === '' || upscaler === '(none)') {
    throw new Error('没有可用的放大模型，请把 ESRGAN 权重放进 models/upscale_models')
  }
  // The server resolves upscalers by name without the file extension.
  const name = upscaler.replace(/\.(pth|pt|safetensors|ckpt|gguf)$/i, '')
  const repeats = Math.max(1, Math.min(4, Math.trunc(Number(inputs.repeats) || 1)))
  const tile = Math.trunc(Number(inputs.tile_size) || 0)

  const out = []
  for (const b64 of images) {
    if (ctx.signal.aborted) throw new Error('已取消')
    const payload = { image: b64, upscaler: name, repeats, output_format: 'png' }
    if (tile > 0) payload.tile_size = tile
    const started = Date.now()
    const result = await request(ctx, 'POST', '/sdcpp/v1/upscale', payload, UPSCALE_TIMEOUT)
    const scaled = (result.images ?? [])
      .map((item) => item.b64_json)
      .filter((value) => typeof value === 'string')
    if (scaled.length === 0) throw new Error('放大失败：' + JSON.stringify(result).slice(0, 200))
    out.push(...scaled)
    ctx.log('upscale x' + (result.scale ?? repeats) + ' -> ' + result.width + 'x' + result.height
      + ' in ' + ((Date.now() - started) / 1000).toFixed(1) + 's')
  }
  return [{ images_b64: out }]
}
