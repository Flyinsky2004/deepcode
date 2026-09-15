import { describe, expect, it } from 'vitest'

import { parseCommandLine, restFrom } from '../../src/commands/parser.js'

describe('parseCommandLine：识别', () => {
  it('不以 / 开头不是命令', () => {
    expect(parseCommandLine('你好')).toBeUndefined()
    expect(parseCommandLine('model use a/b')).toBeUndefined()
  })

  it('只有 / 或 / 加空白不算命令', () => {
    expect(parseCommandLine('/')).toBeUndefined()
    expect(parseCommandLine('/   ')).toBeUndefined()
  })

  it('前导空白被忽略', () => {
    expect(parseCommandLine('   /model')?.name).toBe('model')
  })

  it('切出命令名与位置参数', () => {
    const parsed = parseCommandLine('/model use p/m')
    expect(parsed?.name).toBe('model')
    expect(parsed?.args).toEqual(['use', 'p/m'])
  })

  it('无参数命令', () => {
    const parsed = parseCommandLine('/sessions')
    expect(parsed?.name).toBe('sessions')
    expect(parsed?.args).toEqual([])
  })

  it('重复空白不产生空参数', () => {
    expect(parseCommandLine('/model   use    p/m')?.args).toEqual(['use', 'p/m'])
  })
})

describe('parseCommandLine：引号', () => {
  it('双引号包裹的空格作为单个参数', () => {
    // parts/09 §6.1 第 3 条：provider 展示名允许含空格
    const parsed = parseCommandLine('/workwith "My Provider"/model-id 做点事')
    expect(parsed?.args).toEqual(['My Provider/model-id', '做点事'])
  })

  it('单引号同样支持', () => {
    expect(parseCommandLine("/workwith 'My Provider'/m go")?.args[0]).toBe('My Provider/m')
  })

  it('未闭合的引号按到结尾处理，不抛异常', () => {
    const parsed = parseCommandLine('/workwith "unterminated rest')
    expect(parsed?.args).toEqual(['unterminated rest'])
  })

  it('引号只影响切分，不进入参数值', () => {
    expect(parseCommandLine('/cmd "a b"')?.args).toEqual(['a b'])
  })
})

describe('restFrom：保留原始文本', () => {
  it('从指定位置参数起取回原文，保留空白', () => {
    const parsed = parseCommandLine('/workwith deepseek/v4-flash 完成计划里的实现')
    expect(parsed).toBeDefined()
    expect(restFrom(parsed!, 1)).toBe('完成计划里的实现')
  })

  it('保留内部的多余空白与换行——不重新拼接', () => {
    // 指令原样交给模型；重新拼接会丢掉用户写的换行
    const parsed = parseCommandLine('/workwith p/m   第一行\n  第二行')
    expect(restFrom(parsed!, 1)).toBe('第一行\n  第二行')
  })

  it('restFrom 0 取回全部剩余原文', () => {
    const parsed = parseCommandLine('/init 请扫描工程')
    expect(restFrom(parsed!, 0)).toBe('请扫描工程')
  })

  it('越界返回空串', () => {
    const parsed = parseCommandLine('/workwith p/m')
    expect(restFrom(parsed!, 5)).toBe('')
  })

  it('带引号的参数之后，rest 从正确位置开始', () => {
    const parsed = parseCommandLine('/workwith "My Provider"/m 指令内容')
    expect(restFrom(parsed!, 1)).toBe('指令内容')
  })
})
