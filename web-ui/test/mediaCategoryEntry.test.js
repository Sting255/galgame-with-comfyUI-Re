import test from 'node:test'
import assert from 'node:assert/strict'
import { readMediaSeen, markMediaSeen, mediaCategoryUnread, chooseMediaCategory, chooseMediaRefreshCategory } from '../src/utils/mediaCategoryEntry.js'

const categories = ['traditional', 'digital', 'social']
function memoryStorage(value = null) {
  let saved = value
  return { getItem: () => saved, setItem: (_key, value) => { saved = value } }
}

test('a single unread category always wins over random entry', () => {
  for (const key of categories) {
    for (const random of [0, 0.5, 0.999]) {
      assert.equal(chooseMediaCategory(categories, { [key]: true }, () => random), key)
    }
  }
})

test('multiple unread categories share priority; no unread falls back to all three', () => {
  const unread = { traditional: true, social: true }
  assert.equal(chooseMediaCategory(categories, unread, () => 0), 'traditional')
  assert.equal(chooseMediaCategory(categories, unread, () => 0.999), 'social')
  assert.deepEqual([0, 0.5, 0.999].map(r => chooseMediaCategory(categories, {}, () => r)), categories)
})

test('repeated media navigation opens another updated category even when the current one is unread', () => {
  for (const current of categories) {
    for (const target of categories.filter(key => key !== current)) {
      for (const random of [0, 0.5, 0.999]) {
        assert.equal(chooseMediaRefreshCategory(categories, {
          [current]: true, [target]: true,
        }, current, () => random), target)
      }
    }
  }
})

test('repeated media navigation keeps the current category when no other category has updates', () => {
  for (const current of categories) {
    for (const unread of [{}, { [current]: true }]) {
      assert.equal(chooseMediaRefreshCategory(categories, unread, current), current)
    }
  }
})

test('multiple updates elsewhere share entry priority without returning to the current category', () => {
  const unread = { traditional: true, digital: true, social: true }
  assert.equal(chooseMediaRefreshCategory(categories, unread, 'digital', () => 0), 'traditional')
  assert.equal(chooseMediaRefreshCategory(categories, unread, 'digital', () => 0.999), 'social')
  assert.equal(chooseMediaRefreshCategory(categories, { social: true }, ''), 'social')
})

test('seen posts persist across visits and only newer content signals an update', () => {
  const storage = memoryStorage()
  const seen = markMediaSeen(readMediaSeen(storage), 'digital', 12, storage)
  assert.deepEqual(readMediaSeen(storage), { digital: 12, social: 0 })
  assert.deepEqual(mediaCategoryUnread({ digital: 12, social: 3 }, seen, true), {
    traditional: true, digital: false, social: true
  })
  assert.equal(mediaCategoryUnread({ digital: 13 }, seen, false).digital, true)
  assert.equal(mediaCategoryUnread({ digital: 11 }, seen, false).digital, false)
})

test('older responses and stale tabs cannot move read markers backwards or clear another category', () => {
  const storage = memoryStorage('{"digital":20,"social":30}')
  const seen = markMediaSeen({ digital: 10, social: 0 }, 'digital', 12, storage)
  assert.deepEqual(seen, { digital: 20, social: 30 })
  assert.deepEqual(markMediaSeen(seen, 'social', 0, storage), seen)
  assert.deepEqual(markMediaSeen(seen, 'traditional', 99, storage), seen)
})

test('invalid or unavailable browser storage does not break entry', () => {
  for (const raw of ['broken json', 'null', '{"digital":-1,"social":"999"}']) {
    assert.deepEqual(readMediaSeen(memoryStorage(raw)), { digital: 0, social: 0 })
  }
  const blocked = { getItem() { throw Error('denied') }, setItem() { throw Error('denied') } }
  assert.deepEqual(markMediaSeen(readMediaSeen(blocked), 'social', 8, blocked), { digital: 0, social: 8 })
})
