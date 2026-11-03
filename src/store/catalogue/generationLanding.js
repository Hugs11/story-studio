/** One-shot handoff after the native editor has landed, including effect replay. */
export function consumeGenerationRequest(request, { consumed, catalogueActive, editorReady }) {
  if (!request || request === consumed || catalogueActive || !editorReady) return { consumed, generate: false };
  return { consumed: request, generate: true };
}
