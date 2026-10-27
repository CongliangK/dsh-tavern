import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateInstallationRequest, inspectInstallation, performInstallation } from '../tavern-plugin/packages/dsh-profile-bridge/lib/installation.mjs'
import { registeredTavernTarget, switchProfile, scheduleSwitch } from '../tavern-plugin/packages/dsh-profile-bridge/lib/helper.mjs'
import { beginDesktopProfileInstallation } from '../bin/desktop-profile-installation.mjs'
import location from '../bin/installation-location.cjs'
import { copyTreeSync } from '../bin/portable-fs.mjs'
const repo = fileURLToPath(new URL('../', import.meta.url))
const put = (p, value) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(value)) }
function fixture(t) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'pb-management-e2e-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const home = path.join(root, 'home'), app = path.join(home, 'apps/dsh-tavern')
  const paths = { home, stateDir: path.join(home, 'profile-bridge'), activeDir: path.join(home, 'profiles/desktop') }
  const manifest = name => ({ name, dsh: { profile: { bundles: ['dsh-profile-bridge'] } } })
  put(path.join(app, 'package.json'), manifest('dsh-profile-tavern'))
  put(path.join(app, '.dsh-tavern-local.json'), { host: 'desktop', dshHome: home })
  fs.mkdirSync(path.join(app, 'bin')); fs.copyFileSync(path.join(repo, 'bin/installation-state.cjs'), path.join(app, 'bin/installation-state.cjs'))
  put(path.join(home, 'profiles/tavern/package.json'), manifest('dsh-profile-tavern'))
  put(path.join(paths.activeDir, 'package.json'), manifest('dsh-profile-desktop'))
  put(path.join(home, 'logs/tavern-installation.json'), { host: 'desktop', dshHome: home, sourceRoot: app })
  put(path.join(home, 'profile-data/tavern/sessions/saved.json'), { saved: true })
  put(path.join(home, '.credentials.json'), { token: 'untouched' })
  return { root, home, app, paths, destination: path.join(root, 'other volume 酒馆'), profilesRoot: path.join(home, 'profiles') }
}
const plan = f => validateInstallationRequest(f.paths, 'relocate', { confirmed: true, destination: f.destination })
test('relocation → managed switch → reinstall target → second relocation keeps stable desktop alias', async t => {
  const f = fixture(t)
  const bridgeSource = path.join(repo, 'tavern-plugin/packages/dsh-profile-bridge')
  copyTreeSync(bridgeSource, path.join(f.app, 'tavern-plugin/packages/dsh-profile-bridge'))
  for (const target of ['vendor', 'node_modules']) copyTreeSync(bridgeSource, path.join(f.paths.activeDir, target, 'dsh-profile-bridge'))
  await performInstallation(plan(f))
  assert.equal(location.resolveInstallationApp({ dshHome: f.home }), path.join(f.destination, 'app'))
  assert.equal(registeredTavernTarget(f.profilesRoot, path.join(f.profilesRoot, 'tavern')), path.join(f.destination, 'profile'))
  await switchProfile({ mode: 'link', profilesRoot: f.profilesRoot, liveDir: f.paths.activeDir, targetDir: path.join(f.profilesRoot, 'tavern'), stamp: 'managed' })
  assert.equal(fs.readlinkSync(f.paths.activeDir), path.join(f.profilesRoot, 'tavern'))
  const update = beginDesktopProfileInstallation({ home: f.home, sourceRoot: path.join(f.destination, 'app'), checkStopped() {} })
  assert.equal(update.refreshOnly, true)
  update.finish(); update.commit()
  f.destination = path.join(f.root, 'second location')
  await performInstallation(plan(f))
  assert.equal(fs.realpathSync(f.paths.activeDir), path.join(f.destination, 'profile'))
  await switchProfile({ mode: 'unlink', profilesRoot: f.profilesRoot, liveDir: f.paths.activeDir, stamp: 'restore' })
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.paths.activeDir, 'package.json'))).name, 'dsh-profile-desktop')
  assert.equal(inspectInstallation(f.paths).appDir, path.join(f.destination, 'app'))
})
test('unregistered external profile and symlinked registry fail closed', async t => {
  const f = fixture(t); await performInstallation(plan(f))
  const record = path.join(f.paths.stateDir, 'installation.json'), saved = record + '.saved'
  fs.renameSync(record, saved); fs.symlinkSync(saved, record)
  assert.equal(registeredTavernTarget(f.profilesRoot, path.join(f.profilesRoot, 'tavern')), undefined)
  await assert.rejects(switchProfile({ mode: 'link', profilesRoot: f.profilesRoot, liveDir: f.paths.activeDir, targetDir: path.join(f.profilesRoot, 'tavern'), stamp: 'bad' }), /独立 profile/)
  assert.equal(fs.lstatSync(f.paths.activeDir).isSymbolicLink(), false)
})
test('standalone management worker survives relocating its source and uninstall restores original', async t => {
  const f = fixture(t)
  const run = async request => {
    const receipt = scheduleSwitch({ ...request, stamp: String(Date.now()), pids: [], relaunch: undefined })
    const end = Date.now() + 15000
    let result
    do {
      await new Promise(resolve => setTimeout(resolve, 25))
      result = JSON.parse(fs.readFileSync(path.join(f.paths.stateDir, 'last-result.json')))
    } while ((result.status === 'pending' || fs.existsSync(path.join(f.paths.stateDir, 'pending'))) && Date.now() < end)
    assert.equal(result.status, 'succeeded', JSON.stringify(result))
    assert.ok(receipt.pid > 1)
  }
  await run(plan(f))
  await switchProfile({ mode: 'link', profilesRoot: f.profilesRoot, liveDir: f.paths.activeDir, targetDir: path.join(f.profilesRoot, 'tavern'), stamp: 'before-remove' })
  await run(validateInstallationRequest(f.paths, 'uninstall', { confirmed: true }))
  assert.equal(fs.lstatSync(f.paths.activeDir).isSymbolicLink(), false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.paths.activeDir, 'package.json'))).name, 'dsh-profile-desktop')
  assert.equal(fs.existsSync(path.join(f.profilesRoot, 'tavern')), false)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home, 'profile-data/tavern/sessions/saved.json'))), { saved: true })
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home, '.credentials.json'))), { token: 'untouched' })
  assert.equal(fs.existsSync(path.join(f.home, '.tavern-install.lock')), false)
})
test('unfinished or corrupt management evidence prevents all queued switches before overwriting status', t => {
  const f = fixture(t)
  const record = path.join(f.paths.stateDir, 'installation-operation.json')
  for (const value of [{ schemaVersion: 1, phase: 'preparing' }, { phase: 'completed' }, { schemaVersion: 1, phase: 'unknown' }]) {
    put(record, value)
    assert.throws(() => scheduleSwitch({ mode: 'link', stateDir: f.paths.stateDir }), error => error.recoveryRequired === true)
    assert.equal(fs.existsSync(path.join(f.paths.stateDir, 'pending')), false)
  }
})
