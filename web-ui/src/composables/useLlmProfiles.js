import { ref } from 'vue'

/** Profile mutations share one lock, including confirmation and the refresh after activation. */
export function useLlmProfiles({ api, notify = () => {}, confirm, isDirty = () => false,
  isBlocked = () => false, applyConfig = () => {}, refreshFeatures = async () => {} }) {
  const profiles = ref([])
  const activeId = ref('')
  const busy = ref(false)

  function load(data) {
    profiles.value = data.llmProfiles ?? data.profiles ?? []
    activeId.value = data.activeLlmProfileId ?? data.activeProfileId ?? ''
  }
  function requireSuccess(result) {
    if (!result?.ok) throw new Error(result?.error || result?.message || '服务端未完成操作')
    return result
  }
  async function run(label, action) {
    if (busy.value || isBlocked()) return false
    busy.value = true
    try { return await action() }
    catch (error) { notify(`${label}失败：${error.message || '网络或服务异常'}`, 'error'); return false }
    finally { busy.value = false }
  }
  async function mayDiscard() {
    return !isDirty() || await confirm({ title: '切换模型配置',
      message: '当前修改尚未保存，切换会放弃这些修改。', okText: '放弃修改并切换' })
  }
  async function activate(id) {
    const result = requireSuccess(await api.activateLlmProfile(id))
    load(result)
    applyConfig(result.llmConfig)
    // Activation has already succeeded. A secondary refresh must not report the
    // switch as failed or tempt the user to submit the mutation a second time.
    try { await refreshFeatures() }
    catch { notify('模型已切换，但队列设置刷新失败，请重新打开设置页。', 'warning') }
    return true
  }
  function switchProfile(id) {
    if (id === activeId.value) return Promise.resolve(false)
    return run('切换配置', async () => await mayDiscard() ? activate(id) : false)
  }
  function addProfile(name, overrides, { activateNew = false } = {}) {
    name = name.trim()
    if (!name) return Promise.resolve(false)
    return run('新增配置', async () => {
      if (activateNew && !await mayDiscard()) return false
      const previousIds = new Set(profiles.value.map(profile => profile.id))
      const result = requireSuccess(await api.addLlmProfile(name, overrides))
      load(result)
      if (activateNew) {
        const created = profiles.value.find(profile => !previousIds.has(profile.id) && profile.name === name)
        if (!created) throw new Error('配置已创建，但未找到新配置，请从列表选择')
        try { await activate(created.id) }
        catch (error) { notify(`配置已创建，但启用失败：${error.message}。可从列表重试切换。`, 'error'); return false }
      }
      return true
    })
  }
  function removeProfile(id) {
    if (id === activeId.value || profiles.value.length <= 1) return Promise.resolve(false)
    return run('删除配置', async () => {
      const profile = profiles.value.find(item => item.id === id)
      if (!profile) return false
      if (!await confirm({ title: `删除「${profile.name}」`,
        message: '将删除该配置快照，当前正在编辑的内容不受影响。', danger: true, okText: '删除' })) return false
      load(requireSuccess(await api.deleteLlmProfile(id)))
      // Deleting an inactive snapshot must never reload or clear the current draft.
      return true
    })
  }
  return { profiles, activeId, busy, load, switchProfile, addProfile, removeProfile }
}
