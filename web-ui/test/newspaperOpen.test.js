/**
 * ⚠️ 整文件 skip（2026-10-19 合并上游 v3.10.0 时判定）
 *
 * 上游用例期望打开 2026-10-15 那期日报，本地实际打开 2026-10-16 ⇒ 差一天。
 * 疑与「程序世界日期」或期次选择逻辑有关（上游改了 NewspaperModal / newspaper store）。
 * 这不一定是本地 bug：也可能是上游按自己的 seed 夹具算的期次，与本地夹具差一天。
 * 需要在前端 CONFLICT 合并时一并核对（NewspaperModal.vue 在冲突清单里），
 * 不要为了让测试变绿就改日期期望值 —— 先确认哪一边的日期口径是对的。
 *
 * __MERGE_SKIP_NOTE__ —— 别误以为这是产品功能缺失：后端已经全绿，
 * 这 3 个文件失败纯粹是「上游测试先到、前端实现尚未合并」。
 * 恢复条件：前端 CONFLICT 批次（9 个文件）合并完成后，删掉本段与下面的 test 包装即可。
 *
 * ✅ 2026-10-19 已解禁：真因是 NewspaperModal 缺 `initialDate` prop 与 `localDateKey()`（本地日期口径），
 *    已随上游合并补回；三个 case 全绿。别再把期望日期改成"实际日期"抢绿。
 */
import nodeTest from 'node:test';
// 单点 skip：见文件头说明
const test = nodeTest;
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse, compileScript } from '@vue/compiler-sfc'
import * as Vue from 'vue'

const source = readFileSync(new URL('../src/components/NewspaperModal.vue', import.meta.url), 'utf8')
const code = compileScript(parse(source).descriptor, { id: 'newspaper-open-test' }).content
  .replace(/import\s*\{([^}]+)\}\s*from\s*['"]vue['"]/g, (_, names) => `const { ${names} } = Vue`)
  .replace(/^import .*from.*$/gm, '')
  .replace('export default', 'return')

class LocalDate extends Date {
  constructor(...args) { super(...(args.length ? args : [2026, 9, 16, 0, 30])) }
}

for (const initialDate of ['', '2026-10-16', '2026-10-15']) {
  test(`打开日报：${initialDate || '默认今天'}，加载正确期次且无 watcher 异常`, async t => {
    const today = { publish_date: '2026-10-16', edition: 2, items: [] }
    const past = { publish_date: '2026-10-15', edition: 1, items: [] }
    const requests = [], events = [], errors = []
    const api = {
      getTodayNewspaper: async () => ({ newspaper: today }),
      listNewspaperEditions: async () => ({ editions: [today, past] }),
      getNewspaperByDate: async date => { requests.push(date); return { newspaper: past } },
    }
    const component = new Function('Vue', 'api', 'LinsheButton', 'ImageLightbox',
      'useArticleClip', 'playNewspaperFlipSound', 'window', 'Date', code)(
      Vue, api, {}, {}, () => {}, () => {},
      { addEventListener() {}, removeEventListener() {} }, LocalDate,
    )
    const props = Vue.reactive({ modelValue: false, initialDate })
    let state
    const renderer = Vue.createRenderer({ createComment: () => ({}), insert() {}, remove() {}, parentNode() {}, nextSibling() {} })
    const app = renderer.createApp({ setup() {
      state = component.setup(props, { expose() {}, emit: (...args) => events.push(args) })
      return () => null
    } })
    app.config.errorHandler = error => errors.push(error)
    app.mount({})
    t.after(() => app.unmount())

    props.modelValue = true
    await Vue.nextTick()
    await new Promise(resolve => setImmediate(resolve))

    assert.deepEqual(errors, [])
    assert.equal(state.loading.value, false)
    const isPast = initialDate === past.publish_date
    assert.equal(state.paper.value.publish_date, isPast ? past.publish_date : today.publish_date)
    assert.equal(state.isToday.value, !isPast)
    assert.deepEqual(requests, isPast ? [past.publish_date] : [])
    assert.equal(events.some(([name]) => name === 'read'), !isPast)
  })
}
