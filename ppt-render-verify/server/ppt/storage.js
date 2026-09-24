import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ProjectStore } from './projectStore.js'

export async function openProjectStorage({ env = process.env, localRoot, temporaryParent = os.tmpdir() }) {
  const storageMode = env.PPT_STORAGE_MODE || 'persistent'
  if (!['persistent', 'temporary'].includes(storageMode)) throw new Error('Invalid PPT_STORAGE_MODE')
  if (storageMode === 'temporary' && env.PPT_DATA_ROOT) {
    throw new Error('Temporary PPT storage must not use PPT_DATA_ROOT; leave it unset')
  }
  if (storageMode === 'persistent' && env.NODE_ENV === 'production' && !env.PPT_DATA_ROOT) {
    throw new Error('PPT_DATA_ROOT must point to a persistent volume in production')
  }
  const root = storageMode === 'temporary'
    ? await mkdtemp(path.join(temporaryParent, 'moonwalk-ppt-session-'))
    : env.PPT_DATA_ROOT || localRoot
  const store = await new ProjectStore(root, { storageMode }).init()
  return { store, close: async () => {
    if (storageMode === 'temporary') await rm(root, { recursive: true, force: true })
  } }
}
