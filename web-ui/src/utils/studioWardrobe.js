// 内置场景的固定中文名。自定义类型（custom_*）不在这里 ——
// 它的显示名由每套服装自己的 sceneLabel（用户起的名字）决定。
export const STUDIO_OUTFIT_LABELS = Object.freeze({ work: '默认服装', casual: '私服', home: '居家', sleep: '睡衣' })

/**
 * 生成衣柜下拉的选项列表。
 *
 * 2026-11-13：原来只按 STUDIO_OUTFIT_LABELS 四种硬编码 scene 生成，本项目角色用
 * custom_* 自定义服装类型会被漏掉。现在改成以角色实际服装为准：
 *  - work（默认服装）永远列第一项
 *  - 其余遍历后端 listSceneOutfits 返回的每一套（含 custom_*），已配置且非私密的才列出
 *
 * @param {Array<{scene: string, label?: string, name?: string, description?: string}>} outfits
 *        后端 listSceneOutfits 的返回（scene / sceneLabel / name / description）
 */
export function studioOutfitOptions(outfits = []) {
  const result = [{ value: 'work', label: '默认服装' }]
  for (const outfit of outfits) {
    if (!outfit || outfit.scene === 'work' || !outfit.scene) continue
    if (!outfit.description?.trim()) continue // 没内容的不列出，避免点开是空的
    const label = outfit.sceneLabel || STUDIO_OUTFIT_LABELS[outfit.scene] || outfit.name || outfit.scene
    result.push({ value: outfit.scene, label, name: outfit.name?.trim() || '' })
  }
  return result
}