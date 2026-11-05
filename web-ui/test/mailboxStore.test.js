import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'
import { useMailboxStore } from '../src/stores/mailbox.js'
import { useMailboxActions } from '../src/composables/useMailboxActions.js'

function fixture(t) {
  setActivePinia(createPinia())
  const store = useMailboxStore()
  store.letters = [{ id: 1, status: 'failed', content: '原信', is_read: 0 }]
  const requests = []
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (url.endsWith('/unread')) return Promise.resolve(Response.json({ unread: 0, processing: 0 }))
    return new Promise(resolve => requests.push({ url, options, reply: (data, status = 200) => resolve(Response.json(data, { status })) }))
  })
  return { store, requests }
}

test('old list responses cannot undo a successful retry or resurrect a deleted letter', async t => {
  const { store, requests } = fixture(t)
  for (const action of ['retryLetter', 'deleteLetter']) {
    const stale = store.fetchLetters()
    const list = requests.at(-1)
    const change = store[action](1)
    requests.at(-1).reply({ letter: { id: 1, status: 'pending', content: '原信' } })
    await change
    list.reply({ letters: [{ id: 1, status: 'failed', content: '旧快照' }] })
    await stale
    assert.equal(store.loading, false)
    if (action === 'retryLetter') assert.equal(store.letters[0].status, 'pending')
    else assert.deepEqual(store.letters, [])
  }
})

test('latest refresh wins and a failed request keeps existing letters with a retryable error', async t => {
  const { store, requests } = fixture(t)
  const old = store.fetchLetters()
  const latest = store.fetchLetters()
  requests[1].reply({ letters: [{ id: 1, status: 'completed', reply_content: '新回信' }] })
  await latest
  requests[0].reply({ letters: [] })
  await old
  assert.equal(store.letters[0].reply_content, '新回信')
  const fail = store.fetchLetters()
  requests.at(-1).reply({ error: '暂时离线' }, 503)
  await fail
  assert.equal(store.loadError, '暂时离线')
  assert.equal(store.letters.length, 1)
  const recover = store.fetchLetters()
  requests.at(-1).reply({ letters: [] })
  await recover
  assert.equal(store.loadError, null)
})

test('sending while a list refresh completes does not insert a duplicate letter', async t => {
  const { store, requests } = fixture(t)
  const send = store.sendLetter(2, '', '正文')
  const refresh = store.fetchLetters()
  requests[1].reply({ letters: [{ id: 2, content: '正文' }] })
  await refresh
  requests[0].reply({ letter: { id: 2, content: '正文' } })
  await send
  assert.deepEqual(store.letters.map(l => l.id), [2])
})

test('delete confirmation owns the action lock; failure preserves the selected letter and reports feedback', async t => {
  const { store, requests } = fixture(t)
  const notices = []
  let confirm
  const ui = useMailboxActions(store, () => new Promise(resolve => { confirm = resolve }), (...args) => notices.push(args))
  const deletion = ui.remove(1)
  assert.equal(await ui.remove(1), false)
  await ui.retry(1)
  assert.equal(requests.length, 0)
  confirm(true)
  await Promise.resolve()
  requests[0].reply({ error: '这封信正在回信中' }, 409)
  assert.equal(await deletion, false)
  assert.equal(store.letters.length, 1)
  assert.equal(ui.deletingId.value, null)
  assert.match(notices[0][0], /回信中/)
  const retry = ui.retry(1)
  requests[1].reply({ letter: { id: 1, status: 'pending' } })
  await retry
  assert.equal(store.letters[0].status, 'pending')
  assert.equal(notices.at(-1)[1], 'success')
})
