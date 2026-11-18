/**
 * sd.cpp KSampler — turns the graph values into an `img_gen` request, starts one job per seed
 * and polls until each one finishes. The images come back as PNG base64, which is exactly what
 * `SDCppVAEDecode` and `SaveImage` expect downstream.
 */
const JOB_TIMEOUT = 1_800_000
const POLL_INTERVAL = 1200

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

/** Is the server process still answering? Used to fail fast when it dies mid-run. */
async function isUp(ctx) {
  try {
    await fetch(baseUrl(ctx) + '/sdcpp/v1/models/status', { signal: AbortSignal.timeout(3000) })
    return true
  } catch {
    return false
  }
}

/** Ask the server to stop a job; used when the run itself is cancelled. */
async function cancelJob(ctx, poll) {
  try {
    await fetch(baseUrl(ctx) + poll + '/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    // Best effort: the run is ending either way.
  }
}

async function runJob(ctx, body) {
  const job = await request(ctx, 'POST', '/sdcpp/v1/img_gen', body, 120_000)
  const poll = job.poll_url
  if (typeof poll !== 'string' || poll === '') throw new Error('sd-server 没有返回 poll_url')
  ctx.log('job ' + job.id + ' queued')
  const deadline = Date.now() + JOB_TIMEOUT
  let lastState = null
  let failures = 0
  for (;;) {
    if (ctx.signal.aborted) {
      await cancelJob(ctx, poll)
      throw new Error('已取消')
    }
    let status
    try {
      status = await request(ctx, 'GET', poll, undefined, 60_000)
      failures = 0
    } catch (error) {
      // A busy server can miss a poll without dropping the job — but a cancelled run must not
      // keep retrying for half an hour.
      if (ctx.signal.aborted) {
        await cancelJob(ctx, poll)
        throw new Error('已取消')
      }
      failures += 1
      // A 404 means the server restarted and no longer knows this job.
      if (String(error.message).includes('HTTP 404')) {
        throw new Error('sd-server 重启过，任务已丢失；请重新运行')
      }
      // Three failures in a row means the job is not just busy: check whether the process is
      // still there, so a VRAM crash surfaces in seconds instead of at the 30-minute deadline.
      if (failures >= 3 && (await isUp(ctx)) !== true) {
        throw new Error('sd-server 已退出（多半是显存不足），请降低分辨率后重试')
      }
      if (Date.now() > deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL))
      continue
    }
    const state = String(status.status ?? '')
    if (state !== lastState) {
      lastState = state
      ctx.log('job ' + job.id + ' ' + state)
    }
    if (state === 'completed' || state === 'failed' || state === 'cancelled') {
      const images = (status.result?.images ?? []).map((item) => item.b64_json).filter((value) => typeof value === 'string')
      if (images.length === 0) {
        throw new Error('sd.cpp 采样失败：' + (status.error ?? state))
      }
      return images
    }
    if (Date.now() > deadline) throw new Error('sd.cpp 采样超时（30 分钟）')
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL))
  }
}

/** LoRA names are resolved inside `<root>/models/loras`; a bare name is enough for sd-server. */
function resolveLora(value) {
  if (value === '') return ''
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/')) return value
  // The dropdown lists files as `loras/name.safetensors`; the server resolves bare names.
  return value.slice(value.lastIndexOf('/') + 1)
}

export async function run(inputs, ctx) {
  // The server's loaded model belongs to one workflow at a time; share the run's claim on it.
  const release = typeof ctx.lock === 'function' ? await ctx.lock('sd-server') : () => {}
  if (release === null) throw new Error('已取消')
  if (typeof ctx.onRunEnd === 'function') ctx.onRunEnd(release)

  const seedSource = inputs.seed_source ?? {}
  const seeds = Array.isArray(seedSource.seeds) ? seedSource.seeds : []
  if (seeds.length === 0) throw new Error('seed_source 为空，先运行 Seed 节点')
  const latent = inputs.latent_image ?? {}
  const positive = inputs.positive ?? {}
  const negative = inputs.negative ?? {}
  const model = inputs.model ?? {}
  if (typeof model.recipe !== 'string') throw new Error('model 未加载，先运行 Load Model 节点')

  const body = {
    prompt: String(positive.text ?? ''),
    negative_prompt: String(negative.text ?? ''),
    width: Math.trunc(Number(latent.width) || 512),
    height: Math.trunc(Number(latent.height) || 512),
    sample_params: {
      scheduler: String(inputs.scheduler ?? 'discrete'),
      sample_method: String(inputs.sampler_name ?? 'euler'),
      sample_steps: Math.max(1, Math.trunc(Number(inputs.steps) || 8)),
      eta: 0,
      guidance: { txt_cfg: Number(inputs.cfg ?? 1), distilled_guidance: 0 },
    },
  }

  const cacheMode = String(inputs.cache_mode ?? 'disabled')
  if (cacheMode !== 'disabled') {
    body.cache_mode = cacheMode
    body.cache_option = 'threshold=' + Number(inputs.cache_threshold ?? 0.25)
  }

  const loraName = String(inputs.lora ?? '')
  const chosen = String(inputs.lora_path ?? '').trim() || (loraName !== '(none)' ? loraName : '')
  if (chosen !== '') {
    body.lora = [{ path: resolveLora(chosen, ctx), multiplier: Number(inputs.lora_strength ?? 1) }]
  }

  const collected = []
  for (const seed of seeds) {
    if (ctx.signal.aborted) throw new Error('已取消')
    body.seed = seed
    body.batch_count = 1
    const images = await runJob(ctx, body)
    collected.push(...images)
    ctx.log('seed ' + seed + ' -> ' + images.length + ' image(s)')
  }
  return [{ images_b64: collected, seeds }]
}
