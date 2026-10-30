# dsh-session-delete

给 DSH Web GUI 补上**永久删除会话**的能力（核心只有「归档」）。

核心发行版里，会话行菜单只有 pin / rename / fork / archive 四项，归档只是隐藏 +
阻止唤醒，磁盘上的 `session.v4.jsonl.zstd` 一直在。这个插件在菜单里加一条红色的
**「删除会话」**，确认后真正把会话目录从磁盘上删掉。

## 行为

```
会话行「⋯」→ 删除会话 → 弹窗确认 → POST /api/session-delete
```

Host 侧的删除流程（`lib/index.js`）：

1. 会话正在跑回合（`agent.status === 'running'`）→ **409 拒绝**，什么都不动；
2. `workspaceRegistry.archiveSession(id, { stopActivity: true })` —— 先写归档集合，
   它是 `agent/pre-step` 闸门，删掉之后任何残留的客户端/子智能体都无法再唤醒它；
3. `sessions.detachEntered(entry)`（仅 live 会话）→ `session/disposed` →
   `api-session/removed` → 侧栏那一行立刻消失；
4. 用持久化后端的 `locate(header)` 反算会话目录（不自己重写 project-key 编码），
   校验路径**恰好**是 `<sessionsRoot>/<projectDir>/<sessionDir>` 两层、
   `lstat` 是普通目录、`realpath` 复检仍在 root 内、**符号链接直接拒绝**；
5. `rm -rf` 该目录；cold 会话（只在磁盘上）没有 detach 事件，就手动
   `ctx.emit('api-session/removed', id)`；
6. 客户端若删的是当前打开的会话，则 `uiWorkspace.startSession()` 离开它。

响应示例：

```json
{"ok":true,"sessionId":"session-…","archived":true,"wasLive":false,
 "detached":false,"removedFromDisk":true,"directory":"/…/.dsh/sessions/--…--/session-…"}
```

错误码：`request/invalid-json`、`session/invalid-id`、`session/not-found`、
`session/running`、`session/path-unsafe`、`session/remove-failed`、
`session/list-failed`、`request/method-not-allowed`。

`GET /api/session-delete` 返回 `{"ok":true,"version":"0.1.0","route":"…"}`，用来判断
插件是否已经加载（注意：`/api` 前缀对未认证请求一律 401，探测需要浏览器 cookie）。

## 安装

```bash
git clone https://github.com/bie-666/dsh-session-delete.git ~/.dsh/plugins/dsh-session-delete
dsh plugin --profile web add link:$HOME/.dsh/plugins/dsh-session-delete
```

`dsh plugin add link:` 会把插件挂进 web profile 的 `package.json`；插件自带的
`cordis.patch.yml` 再往组合树里插一行 `- id: session-delete`。

**新的 loader 行只在 `dsh web` 启动时读取**，装完必须重启 DSH：

```bash
pkill -f "dsh web"; dsh web
```

重启后再刷新一次页面，`dsh-client-modules` 才会把 `lib/client.js` 放进 boot roster
（菜单项与弹窗都在这个 bundle 里）。验证是否加载成功：

```bash
curl -s http://127.0.0.1:3080/api/session-delete
# 401 = 路由已注册但请求没带浏览器 cookie（正常）；404 = 插件没加载
```

如果只想手动接线（不用 `dsh plugin add`）：

```bash
ln -sfn ~/.dsh/plugins/dsh-session-delete ~/.dsh/profiles/web/node_modules/dsh-session-delete
# 然后在 ~/.dsh/profiles/web/cordis.patch.yml 末尾加：
# - insert:
#     - id: session-delete
#       name: dsh-session-delete
```

## 卸载

```bash
rm ~/.dsh/profiles/web/node_modules/dsh-session-delete
# 再删掉 ~/.dsh/profiles/web/cordis.patch.yml 里那段 insert（id: session-delete）
```

重启 DSH 即恢复成只有归档的原版行为。插件从不修改核心文件，卸载不会留下补丁。

## 自测

不依赖 DSH 宿主，用桩对象跑完所有分支：

```bash
node ~/.dsh/plugins/dsh-session-delete/test/offline-checks.mjs
```

覆盖：路由注册（单条 GET+POST）、live 删除（archive→detach→rm，且不重复发事件）、
cold 删除（rm + 手动事件）、400/404/409 各种守卫、拒绝 root 外路径 / 深度不符 /
符号链接、无磁盘目录仍发事件，以及客户端 bundle 的两处 slot 注册与菜单项/弹窗渲染。

## 设计约束（踩过的坑）

- **`connection.fetch.register` 以 path 为 key**：同一 path 注册第二次会抛
  `connection: exact Fetch route "…" is already registered`，所以 GET 与 POST
  必须合成一条 `methods: ['GET','POST']`，在 handler 里按 `request.method` 分派。
- `ctx.sessions.get(id)` 返回的是 **session**（有 `.header`），`detachEntered()`
  要的是 **entry** → live 分支用 `ctx.sessions.store.get(id)`。
- 可选服务（`sessionQuery` / `sessionPersistence` / `workspaceRegistry`）一律用
  `ctx.get(name)` 惰性取，只有 `connection` 进 `inject` —— 否则服务缺失时插件永远不
  apply。
- 会话目录不要自己实现 `projectKey()`/`encodeSegment()`；`sessionPersistence.locate()`
  给出的日志路径取 `dirname` 就是会话目录，永远不会和 loader 的布局漂移。

## rc.5 客户端插件规则（一次真实的整页故障）

在 `dsh 0.2.1-rc.5` 上第一版客户端 bundle 曾让**整个页面打不开**（只显示
`Failed to load plugins` + `web boot: 1 entry did not activate dsh-session-delete: failed`）。
教训按重要性排序：

1. **`slots.register({ name })` 必须是真实插槽键**，不是插件名。写成插件名时 rc.5 会抛
   `slot "…" is not declared (a parent entry's children table must declare it)`；
   `apply` 抛错 → 该 entry 的 fiber 变 `FAILED` → **前端 boot 直接中止**，整页拒绝渲染。
2. **不能 `require` 宿主的 Client 包**（`@deepseek-ai/dsh-client-ui-primitives`、
   `react/jsx-runtime` 等）。rc.5 的模块表只放行 `react` 与 `dsh.client.external` 里声明
   的东西，其余一律抛 `client-modules: require("…") missed the module table`。UI 要自己写：
   复制宿主控件的 markup/CSS、类名前缀化、只保留 `--dsw-alias-*` 设计变量。
3. **CSS 从 `apply` 注入**：`ctx.effect(() => { 建 <style data-plugin-css> → 返回移除函数 })`。
   把 `<style>` 塞进插槽组件里会让它的 CSS 文本混进组件树（实测菜单的可访问名变成整段 CSS）。
4. `package.json` 的 `dsh.client` 需要 `platform: "web"`、`immediately: true`、`inject: [...]`
   （`inject` 只影响激活顺序，不是模块依赖声明）。
5. 排查手段：boot 失败时前端只给 `` `<包名>: failed` ``，堆栈被吞。要定位就在 `apply` 里
   逐段包 `try/catch` 打 `console.error`，改完**重启** `dsh web`（bundle 的 `rev` 每个进程
   固定一次，刷新页面没用）。

## 排查记录

升级到 `dsh 0.2.1-rc.5` 时客户端 bundle 曾让整页打不开，定位与修复过程记在
[`docs/troubleshooting-rc5.md`](docs/troubleshooting-rc5.md)。

## 许可证

[MIT](LICENSE)
