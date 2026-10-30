import { onBeforeUnmount, ref } from 'vue'

export function useStandingOutfitConfirmation() {
  const outfitConfirmation = ref({ open: false, missingCharacters: [], sceneLabel: '' })
  let resolveDecision, sequence = 0

  function chooseOutfitPolicy(policy = null) {
    if (![null, 'generate', 'fallback'].includes(policy)) return
    sequence++
    outfitConfirmation.value.open = false
    const resolve = resolveDecision
    resolveDecision = null
    resolve?.(policy)
  }

  async function confirmStandingOutfits(preflight) {
    chooseOutfitPolicy()
    const current = sequence
    const result = await preflight()
    if (current !== sequence) return null
    if (!result.missingCharacters.length) return undefined
    outfitConfirmation.value = { ...result, open: true }
    return new Promise(resolve => { resolveDecision = resolve })
  }

  onBeforeUnmount(() => chooseOutfitPolicy())
  return { outfitConfirmation, confirmStandingOutfits, chooseOutfitPolicy }
}
