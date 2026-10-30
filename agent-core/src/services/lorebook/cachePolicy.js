/** Classify the SOURCE entry, before macros are rendered or snapshots reused.
 * Constant is necessary, but probability, conditions and variable text still
 * make an entry unsafe for a reusable prefix. No runtime state is stored here.
 */
export function classifyCacheEntry(entry) {
  const reasons = [];
  const nonempty = value => Array.isArray(value) ? value.length > 0 : !!String(value ?? '').trim();
  if (!entry?.constant) reasons.push('非无条件常驻');
  if (entry?.useProbability !== false && Number(entry?.probability ?? 100) < 100) reasons.push('概率触发');
  if (nonempty(entry?.group)) reasons.push('分组竞争');
  if (nonempty(entry?.triggers)) reasons.push('生成类型限制');
  if (nonempty(entry?.characterFilter?.names) || nonempty(entry?.characterFilter?.tags)) reasons.push('角色筛选');
  if (['sticky', 'cooldown', 'delay', 'delayUntilRecursion'].some(key => Number(entry?.[key]) > 0)) reasons.push('持续或延迟条件');
  if (entry?.vectorized) reasons.push('向量触发配置');
  if (entry?.position === 7) reasons.push('Outlet 引用条件');
  const macros = [...String(entry?.content || '').matchAll(/\{\{([^{}]+)\}\}/g)];
  if (macros.some(([, body]) => !['newline', 'trim', 'noop'].includes(body.trim().toLowerCase()))) reasons.push('动态或未确认稳定的宏');
  return { tier: reasons.length ? 'dynamic' : 'stable', reasons };
}
