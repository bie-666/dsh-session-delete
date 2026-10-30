/**
 * dsh-session-delete — host half.
 *
 * Adds POST /api/session-delete so the Web GUI can permanently delete a
 * conversation (core only ships archive). The deletion is deliberately
 * conservative:
 *
 *   1. refuse while the session's agent is mid-turn (`status === 'running'`);
 *   2. archive it with `stopActivity` first — the durable archive set is the
 *      `agent/pre-step` gate, so nothing can wake the session afterwards;
 *   3. detach the live session (`sessions.detachEntered`), which emits
 *      `session/disposed` → `api-session/removed` → the sidebar row vanishes;
 *   4. remove exactly `<sessionRoot>/<projectDir>/<sessionDir>` after proving
 *      the resolved path really sits two levels below the session root and is
 *      a plain directory (never a symlink);
 *   5. emit `api-session/removed` ourselves when the session was not live
 *      (cold rows only exist on disk).
 *
 * The session directory is derived from the persistence backend's own
 * `locate(meta)` instead of re-implementing project-key encoding, so the path
 * always matches how the loader wrote it.
 */

import { lstat, realpath, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

const ROUTE = '/api/session-delete'
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._~:@-]{0,255}$/
const VERSION = '0.1.0'

const encoder = new TextEncoder()

function json(status, body) {
  return new Response(encoder.encode(JSON.stringify(body)), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function failure(status, code, message, extra) {
  return json(status, { ok: false, error: { code, message, ...extra } })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function inside(root, target) {
  return target.startsWith(root.endsWith('/') ? root : root + '/')
}

/** Resolve the on-disk session directory for a header, or a reason we will not touch it. */
/** Lexical guard: `directory` must be exactly root/<project>/<session>. */
function layoutProblem(root, directory) {
  if (!inside(root, directory)) return 'path is outside the session root'
  const relative = directory.slice(root.endsWith('/') ? root.length : root.length + 1)
  const segments = relative.split('/').filter((segment) => segment.length > 0)
  if (segments.length !== 2) return `unexpected session layout (depth ${segments.length}): ${relative}`
  return undefined
}

async function sessionDirectory(persistence, header) {
  if (persistence === undefined || typeof persistence.locate !== 'function') {
    return { error: 'session persistence service unavailable' }
  }
  const root = persistence.root
  if (typeof root !== 'string' || root.length === 0) {
    return { error: 'session persistence root is unknown' }
  }
  let located
  try {
    located = persistence.locate({ cwd: header.cwd, id: header.id })
  } catch (error) {
    return { error: `locate() failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  const logPath = located?.path
  if (typeof logPath !== 'string' || logPath.length === 0) {
    return { error: 'locate() returned no log path' }
  }
  const directory = dirname(logPath)
  // Check the computed path before touching the filesystem: a locate() that
  // points anywhere else must never reach rm().
  const lexical = layoutProblem(root, directory)
  if (lexical !== undefined) return { error: lexical }

  let realRoot
  try {
    realRoot = await realpath(root)
  } catch (error) {
    return { error: `session root is not readable: ${error instanceof Error ? error.message : String(error)}` }
  }
  let lexicalStats
  try {
    lexicalStats = await lstat(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') return { missing: true, directory }
    return { error: `cannot stat session directory: ${error instanceof Error ? error.message : String(error)}` }
  }
  // A symlinked session directory could redirect the delete at another
  // conversation; the loader never creates one, so treat it as tampering.
  if (lexicalStats.isSymbolicLink()) return { error: 'session directory is a symbolic link' }
  if (!lexicalStats.isDirectory()) return { error: 'session path is not a directory' }

  let realDirectory
  try {
    realDirectory = await realpath(directory)
  } catch (error) {
    return { error: `session directory is not readable: ${error instanceof Error ? error.message : String(error)}` }
  }
  // Re-check the physical path: symlinks must not relocate the target.
  const physical = layoutProblem(realRoot, realDirectory)
  if (physical !== undefined) return { error: physical }
  let stats
  try {
    stats = await lstat(realDirectory)
  } catch (error) {
    return { error: `cannot stat session directory: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!stats.isDirectory()) return { error: 'session path is not a plain directory' }
  return { directory: realDirectory }
}

async function deleteSession(ctx, request) {
  let payload
  try {
    payload = await request.json()
  } catch {
    return failure(400, 'request/invalid-json', '请求体必须是 JSON 对象')
  }
  const sessionId = payload?.sessionId
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
    return failure(400, 'session/invalid-id', 'sessionId 缺失或格式不合法')
  }

  const sessions = ctx.get('sessions')
  const agents = ctx.get('agents')
  const query = ctx.get('sessionQuery')
  const persistence = ctx.get('sessionPersistence')
  const registry = ctx.get('workspaceRegistry')

  const live = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
  const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined

  let header = live?.header
  if (header === undefined && typeof query?.listSessions === 'function') {
    let records
    try {
      records = await query.listSessions()
    } catch (error) {
      return failure(500, 'session/list-failed', `读取会话列表失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const found = Array.isArray(records) ? records.find((record) => record?.header?.id === sessionId) : undefined
    header = found?.header
  }
  if (header === undefined) {
    return failure(404, 'session/not-found', `会话 ${sessionId} 不存在或已被删除`)
  }
  if (agent !== undefined && agent.status === 'running') {
    return failure(409, 'session/running', '该会话正在运行，请先停止当前工作后再删除')
  }

  // Block any later wake-up before touching the conversation: the archive set is
  // the `agent/pre-step` gate, so even a stale resident client cannot revive it.
  let archived = false
  if (typeof registry?.archiveSession === 'function') {
    try {
      await registry.archiveSession(sessionId, { stopActivity: true })
      archived = true
    } catch (error) {
      ctx.logger?.('session-delete')?.warn?.(`archiveSession(${sessionId}) failed:`, error)
    }
  }

  let resolved
  try {
    resolved = await sessionDirectory(persistence, header)
  } catch (error) {
    resolved = { error: error instanceof Error ? error.message : String(error) }
  }
  if (resolved.error !== undefined) {
    return failure(500, 'session/path-unsafe', `无法安全定位会话目录：${resolved.error}`)
  }

  let detached = false
  const entry = sessions?.store?.get?.(sessionId)
  if (entry !== undefined && typeof sessions.detachEntered === 'function') {
    try {
      sessions.detachEntered(entry)
      detached = true
    } catch (error) {
      ctx.logger?.('session-delete')?.warn?.(`detachEntered(${sessionId}) failed:`, error)
    }
  }

  let removedFromDisk = false
  if (resolved.directory !== undefined) {
    if (detached) await sleep(120)
    try {
      if (resolved.missing !== true) {
        await rm(resolved.directory, { recursive: true, force: true })
        removedFromDisk = true
      }
    } catch (error) {
      return failure(500, 'session/remove-failed', `删除会话目录失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (!detached) {
    try {
      ctx.emit('api-session/removed', sessionId)
    } catch (error) {
      ctx.logger?.('session-delete')?.warn?.('emit api-session/removed failed:', error)
    }
  }

  return json(200, {
    ok: true,
    sessionId,
    archived,
    wasLive: live !== undefined,
    detached,
    removedFromDisk,
    directory: resolved.directory ?? null,
  })
}

export default {
  name: 'dsh-session-delete',
  apply(ctx) {
    // Only `connection` is required; every other service is resolved lazily so
    // a missing optional dependency can never keep this plugin from applying.
    ctx.inject(['connection'], (scoped) => {
      // One exact route per path: the registry keys routes by path, so GET and
      // POST must share a single entry and dispatch on the method instead.
      scoped.effect(
        () =>
          scoped.connection.fetch.register({
            path: ROUTE,
            methods: ['GET', 'POST'],
            requestBody: 'buffered',
            fetch: (request) => {
              if (request.method === 'POST') return deleteSession(scoped, request)
              if (request.method === 'GET') return json(200, { ok: true, version: VERSION, route: ROUTE })
              return failure(405, 'request/method-not-allowed', '只支持 GET 与 POST')
            },
          }),
        'session-delete: /api/session-delete',
      )
    })
  },
}
