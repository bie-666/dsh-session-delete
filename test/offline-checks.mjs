/**
 * Offline checks for dsh-session-delete — no DSH host required.
 *
 * Run: node test/offline-checks.mjs
 *
 * Covers: route registration, the live and cold delete paths, every guard
 * (bad input, unknown session, running turn, path escape, wrong layout,
 * symlinked directory), and the client bundle wiring (slot registrations,
 * menu item + confirmation dialog rendering).
 */
import { mkdirSync, writeFileSync, existsSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const libUrl = new URL('../lib/index.js', import.meta.url).href
const clientUrl = new URL('../lib/client.js', import.meta.url).href
const plugin = await import(libUrl)
const ROOT = '/tmp/sd-root'
rmSync(ROOT, { recursive: true, force: true })

function makeTree(project, id) {
  const dir = join(ROOT, project, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), 'x')
  writeFileSync(join(dir, 'session.lock'), '')
  return dir
}

let captured = {}
function makeCtx({ live = true, running = false, sessions = [], locate } = {}) {
  const emitted = []
  const archived = []
  let detached = false
  const store = new Map()
  if (live) store.set('s-1', { id: 's-1' })
  const ctx = {
    get(name) {
      if (name === 'sessions') return {
        get: (id) => (live && id === 's-1' ? { header: { id: 's-1', cwd: '/tmp/work' } } : undefined),
        store,
        detachEntered: (entry) => { store.delete(entry.id); detached = true },
      }
      if (name === 'agents') return { get: () => (running ? { status: 'running' } : undefined) }
      if (name === 'sessionQuery') return { listSessions: async () => sessions.map((id) => ({ header: { id, cwd: '/tmp/work' } })) }
      if (name === 'sessionPersistence') return { root: ROOT, locate: locate ?? ((meta) => ({ kind: 'jsonl', path: join(ROOT, 'proj', meta.id, 'session.v4.jsonl.zstd') })) }
      if (name === 'workspaceRegistry') return { archiveSession: async (id, o) => { archived.push([id, o]) } }
      return undefined
    },
    emit: (event, payload) => emitted.push([event, payload]),
    logger: () => ({ warn: () => {} }),
    on() {},
    effect: (fn) => { fn(); return () => {} },
    inject: (names, cb) => cb(ctx),
    connection: {
      fetch: {
        register: (route) => { captured.route = route; return () => {} },
      },
    },
  }
  return { ctx, state: { emitted, archived, get detached() { return detached } } }
}

async function post(body, raw) {
  const request = new Request('http://127.0.0.1:3080/api/session-delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  })
  const response = await captured.route.fetch(request)
  return { status: response.status, body: await response.json() }
}

// ---- registration -------------------------------------------------------
{
  const { ctx } = makeCtx()
  plugin.default.apply(ctx)
  assert.equal(captured.route?.path, '/api/session-delete')
  assert.deepEqual(captured.route.methods, ['GET', 'POST'])
  assert.equal(captured.route.requestBody, 'buffered')
  const probe = await captured.route.fetch(new Request('http://x/api/session-delete'))
  assert.equal(probe.status, 200)
  assert.equal((await probe.json()).ok, true)
  console.log('ok  registration (single exact route, GET+POST)')
}

// ---- happy path: live session, dir removed, detach emits -----------------
{
  const dir = makeTree('proj', 's-1')
  const expectedDir = realpathSync(dir)
  const { ctx, state } = makeCtx()
  plugin.default.apply(ctx)
  const result = await post({ sessionId: 's-1' })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal(result.body.ok, true)
  assert.equal(result.body.wasLive, true)
  assert.equal(result.body.detached, true)
  assert.equal(result.body.removedFromDisk, true)
  assert.equal(result.body.directory, expectedDir)
  assert.equal(existsSync(dir), false, 'session dir must be gone')
  assert.deepEqual(state.archived, [['s-1', { stopActivity: true }]])
  assert.deepEqual(state.emitted, [], 'live detach already emits session/disposed')
  console.log('ok  live delete (archive → detach → rm, no duplicate event)')
}

// ---- cold session: file removed, removed event emitted -------------------
{
  const dir = makeTree('proj', 's-2')
  const { ctx, state } = makeCtx({ live: false, sessions: ['s-2'] })
  plugin.default.apply(ctx)
  const result = await post({ sessionId: 's-2' })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal(result.body.wasLive, false)
  assert.equal(result.body.detached, false)
  assert.equal(existsSync(dir), false)
  assert.deepEqual(state.emitted, [['api-session/removed', 's-2']])
  console.log('ok  cold delete (rm + api-session/removed)')
}

// ---- guards --------------------------------------------------------------
{
  const makeDirGuard = (payload, expectedStatus, label) => async () => {
    const { ctx } = makeCtx()
    plugin.default.apply(ctx)
    const result = await post(payload)
    assert.equal(result.status, expectedStatus, `${label}: ${JSON.stringify(result.body)}`)
    return result
  }
  await (async () => {
    const { ctx } = makeCtx()
    plugin.default.apply(ctx)
    const bad = await post(undefined, 'not json')
    assert.equal(bad.status, 400)
    assert.equal(bad.body.error.code, 'request/invalid-json')
    const badId = await post({ sessionId: '../../etc' })
    assert.equal(badId.status, 400)
    assert.equal(badId.body.error.code, 'session/invalid-id')
    const missing = await post({ sessionId: 'nope' })
    assert.equal(missing.status, 404)
    assert.equal(missing.body.error.code, 'session/not-found')
  })()
  console.log('ok  400 invalid json / 400 invalid id / 404 unknown session')

  // running session
  const dirRunning = makeTree('proj', 's-1')
  const running = makeCtx({ running: true })
  plugin.default.apply(running.ctx)
  const busy = await post({ sessionId: 's-1' })
  assert.equal(busy.status, 409)
  assert.equal(busy.body.error.code, 'session/running')
  assert.equal(existsSync(dirRunning), true, 'running session must be untouched')
  console.log('ok  409 while the agent is mid-turn (nothing touched)')

  // locate() pointing outside the session root
  const escaped = makeCtx({ locate: () => ({ kind: 'jsonl', path: '/tmp/definitely-not-a-session/log.jsonl' }) })
  plugin.default.apply(escaped.ctx)
  const outside = await post({ sessionId: 's-1' })
  assert.equal(outside.status, 500)
  assert.equal(outside.body.error.code, 'session/path-unsafe')
  console.log('ok  refuses a locate() path outside the session root')

  // wrong depth (directly under root)
  const shallow = makeCtx({ locate: () => ({ kind: 'jsonl', path: join(ROOT, 'session.v4.jsonl.zstd') }) })
  plugin.default.apply(shallow.ctx)
  const depth = await post({ sessionId: 's-1' })
  assert.equal(depth.status, 500)
  assert.equal(depth.body.error.code, 'session/path-unsafe')
  console.log('ok  refuses a directory that is not <root>/<project>/<session>')

  // symlinked directory
  const realDir = makeTree('proj', 's-3')
  const linkDir = join(ROOT, 'proj', 's-link')
  symlinkSync(realDir, linkDir)
  const symlinked = makeCtx({ live: false, sessions: ['s-link'], locate: () => ({ kind: 'jsonl', path: join(linkDir, 'session.v4.jsonl.zstd') }) })
  plugin.default.apply(symlinked.ctx)
  const viaLink = await post({ sessionId: 's-link' })
  assert.equal(viaLink.status, 500, JSON.stringify(viaLink.body))
  assert.equal(existsSync(realDir), true, 'symlink target must survive')
  console.log('ok  refuses a symlinked session directory (target intact)')

  // missing directory (never materialized) still drops the row
  const gone = makeCtx({ live: false, sessions: ['s-9'] })
  plugin.default.apply(gone.ctx)
  const absent = await post({ sessionId: 's-9' })
  assert.equal(absent.status, 200, JSON.stringify(absent.body))
  assert.equal(absent.body.removedFromDisk, false)
  assert.deepEqual(gone.state.emitted, [['api-session/removed', 's-9']])
  console.log('ok  a session with no on-disk dir still emits api-session/removed')
}

// ---- client bundle wiring ------------------------------------------------
{
  const react = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props ?? {}), ...(children.length > 0 ? { children: children.length === 1 ? children[0] : children } : {}) },
    }),
    useState: (initial) => [initial, () => {}],
    useCallback: (fn) => fn,
    useEffect: () => {},
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  }
  function render(node) {
    if (node === null || node === undefined || node === false || node === true) return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(render).join('')
    if (typeof node.type === 'function') return render(node.type(node.props))
    return render(node.props?.children)
  }
  function findAll(node, predicate, out = []) {
    if (node === null || node === undefined || Array.isArray(node)) {
      if (Array.isArray(node)) node.forEach((child) => findAll(child, predicate, out))
      return out
    }
    if (typeof node !== 'object') return out
    if (typeof node.type === 'function') return findAll(node.type(node.props), predicate, out)
    if (predicate(node)) out.push(node)
    findAll(node.props?.children, predicate, out)
    return out
  }

  const registrations = []
  let dictionaries = null
  let styleInstalled = 0

  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, remove() {} }),
    head: { appendChild: () => { styleInstalled += 1 } },
  }

  const requireStub = (name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require(${name})`)
  }
  globalThis.window = { __ModuleLoader__: { load: ({ id, factory }) => { window.__loadedId = id; window.__exports = factory(requireStub) } } }
  globalThis.fetch = async (url, init) => {
    window.__fetched = { url, init }
    return { ok: true, status: 200, json: async () => ({ ok: true, sessionId: 's-1' }) }
  }
  await import(clientUrl)
  assert.equal(window.__loadedId, 'dsh-session-delete')
  const mod = window.__exports
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['slots', 'locale', 'uiWorkspace'])

  const workspace = { mainReference: { sessionId: 's-1' }, started: 0, startSession() { this.started += 1 } }
  const ctx = {
    get: (name) => (name === 'uiWorkspace' ? workspace : undefined),
    locale: {
      register: (ns, dict) => { dictionaries = { ns, dict } },
      bind: () => (key, vars) => key + (vars ? ':' + JSON.stringify(vars) : ''),
    },
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
    slots: {
      inject: (slot, setup) => {
        const iterator = setup()
        let step = iterator.next()
        while (!step.done) { registrations.push({ slot, ...step.value }); step = iterator.next() }
      },
      register: (options, Component) => ({ ...options, Component }),
    },
  }
  mod.apply(ctx)
  assert.equal(styleInstalled, 1, 'the stylesheet is installed once from apply, not from the menu render')
  assert.equal(dictionaries.ns, 'session-delete')
  assert.equal(dictionaries.dict.zh['menu.deleteSession'], '删除会话')
  const menu = registrations.find((r) => r.slot === 'sidebar.workspaces.session.menu.item')
  const overlay = registrations.find((r) => r.slot === 'shell.overlay')
  assert.equal(menu.id, 'session-delete.delete')
  assert.equal(menu.order, 500)
  assert.equal(menu.locale, 'session-delete')
  assert.equal(overlay.id, 'session-delete.dialog')
  assert.equal(overlay.order, 900)
  console.log('ok  client regs: menu item order 500 + overlay dialog order 900, inject', JSON.stringify(mod.inject))

  const t = (key, vars) => {
    const template = dictionaries.dict.zh[key] ?? key
    return vars === undefined ? template : template.replace(/\{(\w+)\}/g, (_, name) => String(vars[name]))
  }
  let closedMenu = null
  const Item = menu.Component
  const itemProps = { sessionId: 's-1', displayTitle: '示例会话', useMenuOpenState: () => [true, (v) => { closedMenu = v }], t }
  const itemNode = Item(itemProps)
  const buttons = findAll(itemNode, (node) => node.type === 'button')
  assert.equal(buttons.length, 1, 'exactly one button in the menu item')
  assert.match(buttons[0].props.className, /dshsd-danger/)
  assert.match(render(itemNode), /删除会话/)
  assert.doesNotMatch(render(itemNode), /dshsd-item\{/, 'no stylesheet text leaks into the slot content')
  console.log('ok  menu item renders "删除会话" with danger styling')

  const Dialog = overlay.Component
  assert.equal(render(react.createElement(Dialog, { t })), '', 'dialog renders nothing without a pending request')
  buttons[0].props.onClick()
  assert.equal(closedMenu, false, 'selecting the item closes the menu')

  const html = render(react.createElement(Dialog, { t }))
  assert.match(html, /永久删除此会话？/)
  assert.match(html, /「示例会话」/)
  assert.match(html, /永久删除/)
  assert.match(html, /取消/)
  console.log('ok  dialog renders title/description/buttons from the pending request')
}
