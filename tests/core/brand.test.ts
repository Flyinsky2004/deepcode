import { describe, expect, it } from 'vitest'

import { brandAs, type Brand } from '../../src/core/brand.js'

type UserId = Brand<string, 'UserId'>
type OrderId = Brand<string, 'OrderId'>

describe('brandAs', () => {
  it('运行期是恒等变换，不改变值', () => {
    const id = brandAs<UserId>('abc')
    expect(id).toBe('abc')
    expect(typeof id).toBe('string')
  })

  it('品牌类型在编译期互不兼容（此处用交叉赋值验证收窄行为）', () => {
    // 品牌类型只影响编译期。运行期它们都是 string，因此可以自由序列化。
    const userId = brandAs<UserId>('user-1')
    const orderId = brandAs<OrderId>('order-1')

    // @ts-expect-error UserId 不能赋值给 OrderId —— 这正是品牌类型的目的
    const wrong: OrderId = userId

    expect(wrong).toBe('user-1')
    expect(orderId).toBe('order-1')
  })

  it('品牌值可直接参与字符串运算与 JSON 序列化', () => {
    const id = brandAs<UserId>('abc')
    expect(`${id}-suffix`).toBe('abc-suffix')
    expect(JSON.stringify({ id })).toBe('{"id":"abc"}')
  })
})
