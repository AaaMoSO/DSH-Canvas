/**
 * sd.cpp VAE Decode — sd.cpp hands back finished PNGs, so decoding is just passing the images
 * along in the shape the image nodes expect.
 */
export async function run(inputs) {
  const samples = inputs.samples ?? {}
  const images = Array.isArray(samples.images_b64) ? samples.images_b64 : []
  if (images.length === 0) throw new Error('samples 里没有图片')
  return [{ images_b64: images }]
}
