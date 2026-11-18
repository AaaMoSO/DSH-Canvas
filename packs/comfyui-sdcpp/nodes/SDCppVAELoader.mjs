/**
 * sd.cpp VAE Loader — in this backend the VAE is loaded together with the model, so the node
 * only names the file that `SDCppLoadModel` should use.
 */
export async function run(inputs) {
  return [String(inputs.vae_name ?? '')]
}
