import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { canonicalWorkspace, resolveAppPaths } from '../../src/storage/paths.js'
import { listStoredProjects, prepareProjectStorage } from '../../src/storage/project-storage.js'

describe('项目数据目录', () => {
  it('首次打开复制旧会话和事件，保留原件，再打开不覆盖新历史', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deepcode-project-'))
    const workspace = join(root, 'workspace')
    const legacy = join(workspace, '.deepcode')
    await mkdir(join(legacy, 'events'), { recursive: true })
    await writeFile(join(legacy, 'chat.json'), '{"schema_version":1,"conversations":[]}')
    await writeFile(join(legacy, 'events', 'old.ndjson'), 'old event\n')
    const paths = resolveAppPaths({ home: root, cwd: workspace })

    await prepareProjectStorage(paths)
    expect(await readFile(paths.chat_path, 'utf8')).toContain('conversations')
    expect(await readFile(join(paths.project_dir, 'events', 'old.ndjson'), 'utf8')).toBe(
      'old event\n',
    )
    expect(await readFile(join(legacy, 'chat.json'), 'utf8')).toContain('conversations')

    await writeFile(paths.chat_path, 'new history')
    await prepareProjectStorage(paths)
    expect(await readFile(paths.chat_path, 'utf8')).toBe('new history')
    expect(await listStoredProjects(paths.global_dir)).toEqual([
      expect.objectContaining({
        path: canonicalWorkspace(workspace),
        id: paths.project_dir.split('/').at(-1),
      }),
    ])
  })

  it('同名目录的项目分别存储', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deepcode-project-'))
    const one = resolveAppPaths({ home: root, cwd: join(root, 'one', 'app') })
    const two = resolveAppPaths({ home: root, cwd: join(root, 'two', 'app') })
    expect(one.project_dir).not.toBe(two.project_dir)
  })
})
