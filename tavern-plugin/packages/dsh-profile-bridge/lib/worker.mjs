import { readFileSync, writeFileSync, appendFileSync, rmSync, rmdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { waitForExit, switchProfile, relaunchApp } from './helper.mjs'
import { cleanupOwnedProcesses, waitForOwnedExit } from './processes.mjs'

/** Run outside the profiles tree; never relaunch an app after failed recovery. */
export async function runSwitchJob(job, {
  wait = waitForExit, waitOwned = waitForOwnedExit, perform = switchProfile, cleanup = cleanupOwnedProcesses,
  relaunch = relaunchApp,
} = {}) {
  const lock = dirname(job)
  try { writeFileSync(join(lock, 'worker.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { flag: 'wx', mode: 0o600 }) } catch {}
  let request
  let exited = false
  let recoveryRequired = false
  let failed = false
  let log = () => {}
  try {
    request = JSON.parse(readFileSync(job, 'utf8'))
    log = message => appendFileSync(join(request.stateDir, 'last-run.log'), new Date().toISOString() + ' ' + message + '\n')
    const persist = result => writeFileSync(join(request.stateDir, 'last-result.json'), JSON.stringify({
      mode: request.mode, stamp: request.stamp, finishedAt: new Date().toISOString(),
      logPath: join(request.stateDir, 'last-run.log'), ...result,
    }), { mode: 0o600 })
    log(`已排队 ${request.stamp} (${request.mode})，等待官方桌面正常退出。`)
    try {
      if (request.ownership) await waitOwned(request.ownership)
      else await wait(request.pids)
      exited = true
      let cleaned = false
      const result = await perform(request, { retry: { onRetry: async ({ from, to, code, attempt }) => {
        log(`目录占用重试 ${attempt}: ${code} ${from} → ${to}`)
        if (!cleaned) {
          cleaned = true
          // Only identities captured while Desktop was still alive are eligible.
          // Unrelated sessions and unknown occupiers are never force-closed.
          if (request.ownership) await cleanup(request.ownership, { log })
          else log('无可验证的桌面子进程记录；仅等待目录锁释放，不结束任何进程。')
        }
      } } })
      log(JSON.stringify(result))
      persist({ status: 'succeeded', message: '切换完成。' })
      log('切换完成。')
    } catch (error) {
      failed = true
      recoveryRequired = error.recoveryRequired === true
      log('ERROR: ' + error.message)
      persist({ status: 'failed', message: error.message, code: error.code, recoveryRequired })
    }
  } catch (error) {
    failed = true
    log('ERROR: ' + error.message)
  } finally {
    if (exited && !recoveryRequired && request?.relaunch) {
      try { relaunch(request.relaunch); log('已重新打开官方桌面。') } catch (error) { log('ERROR: 无法重新打开官方桌面：' + error.message) }
    }
    if (recoveryRequired) log('入口需要手动恢复，未重新打开桌面；请保留备份和日志。')
    rmSync(job, { force: true })
    rmSync(join(lock, 'worker.json'), { force: true })
    rmdirSync(lock)
  }
  return failed ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runSwitchJob(process.argv[2])
}
