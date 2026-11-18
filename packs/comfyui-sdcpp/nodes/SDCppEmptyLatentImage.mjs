/**
 * sd.cpp Empty Latent Image — carries the canvas size. The batch comes from the seed node, so a
 * batch control here would be a second source of truth.
 */
export async function run(inputs) {
  const width = Math.trunc(Number(inputs.width) || 512)
  const height = Math.trunc(Number(inputs.height) || 512)
  return [{ width, height, batch: 1 }]
}
