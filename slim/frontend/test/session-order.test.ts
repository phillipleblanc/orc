import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reorder, sidebarOrder } from '../src/session-order.ts'

test('sessions go in the order Orc.app\'s sidebar shows them, each parent followed by its children', () => {
  assert.deepEqual(sidebarOrder(['orca-frontend-review', 'unrelated', 'orca-frontend'], []), ['unrelated', 'orca-frontend', 'orca-frontend-review'])
  assert.deepEqual(sidebarOrder(['orca-frontend-review', 'orca-frontend', 'orca'], []), ['orca', 'orca-frontend-review', 'orca-frontend'],
    'one level deep: a child is never another\'s parent')
  assert.deepEqual(sidebarOrder(['a', 'a-one', 'a-two', 'b', 'b-one', 'c'], ['c', 'b-one', 'a-two', 'b', 'gone']), ['c', 'b', 'b-one', 'a', 'a-two', 'a-one'],
    'parents by their keys, children by theirs among their siblings, and sessions without a key after')
  assert.deepEqual(sidebarOrder(['a-', 'a'], []), ['a-', 'a'], 'a name ending in a hyphen has no parent')
})

test('sessions moved elsewhere take the places they held, in their new order', () => {
  assert.deepEqual(reorder(['gamma', 'delta'], ['gamma', 'delta', 'alpha', 'alpha-review'], ['alpha', 'alpha-review', 'delta', 'gamma']),
    ['alpha', 'alpha-review', 'delta', 'gamma'])
  assert.deepEqual(reorder(['x', 'b', 'y', 'a'], ['b', 'a', 'c'], ['a', 'b']), ['x', 'a', 'y', 'b', 'c'], 'other keys keep their places')
})
