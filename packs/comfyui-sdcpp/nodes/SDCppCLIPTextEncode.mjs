/**
 * sd.cpp CLIP Text Encode — sd.cpp re-encodes the prompt per request, so this node is only a
 * carrier: `text` in, `{ text }` out.
 */
export async function run(inputs) {
  return [{ text: String(inputs.text ?? '') }]
}
