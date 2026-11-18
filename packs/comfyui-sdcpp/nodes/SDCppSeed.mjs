/**
 * sd.cpp Seed — produces the seed list the sampler iterates over.
 *
 * `mode: "random"` re-rolls every run (there is no cache to defeat here), `"fixed"` uses
 * `seed_value`. Returns `[seedSource, seedsAsText]`, matching the Python node.
 */
export async function run(inputs, ctx) {
  const mode = String(inputs.mode ?? 'fixed')
  const batch = Math.max(1, Math.min(64, Math.trunc(Number(inputs.batch_count) || 1)))
  const seeds = mode === 'random'
    ? Array.from({ length: batch }, () => Math.floor(Math.random() * 0x7fffffff))
    : [Math.trunc(Number(inputs.seed_value) || 0)]
  ctx.log('seeds (' + mode + '): ' + seeds.join(', '))
  return [{ mode, seeds }, seeds.join(', ')]
}
