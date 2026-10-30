# 排查记录：rc.5 下「整页打不开」与「菜单项不显示」

在 `dsh 0.2.1-rc.5` 上，这个插件的第一版客户端 bundle 会让整个 Web 应用**拒绝渲染**：
页面只剩 `HARNESS` / `Failed to load plugins` / `dsh-session-delete` /
`web boot: 1 entry did not activate dsh-session-delete: failed`。

## 一、为什么一个坏插件能弄挂整页

rc.5 前端的 boot 是**全局一次性校验**：

1. `modules.entries.start(loader, manifest)` 把清单里的 client 插件全部拉起来；
2. `await loader.await()`；
3. 逐条检查每个 entry 的 fiber 状态，只要有一个不是 `active`，就
   `throw new Error('web boot: N entry/entries did not activate …')`，
   整个应用 UI 不再挂载，只渲染一张错误卡片。

卡片每行只有 `<包名>: <状态>`，**每个 entry 的真实堆栈被吞掉**。状态词映射：
`pending` / `loading` / `active` / `failed` / `disposed` / `unloading`——`failed`
的含义是「fiber 存在，但 `apply` 抛了异常」。

`dsh.client.immediately: true` 的条目在 boot 阶段就被 eagerly 启动，没有懒加载降级，
所以 `apply` 里任何一次抛错都是致命的。对照：host 插件失败只会让该 entry 不激活
（日志里是 `warning: N entries did not activate`），页面照常能开。

## 二、踩中的两条 rc.5 规则

1. **`slots.register({ name })` 的 `name` 必须是已声明的插槽键**，不是插件名。
   写成插件名时抛：

   ```
   Error: slot "session-delete" is not declared
     (a parent entry's children table must declare it)
   ```

2. **不能 `require` 宿主的 Client 包**（`@deepseek-ai/dsh-client-ui-primitives`、
   `react/jsx-runtime` 等）。rc.5 的模块表只 seed 了 `react` 这类 baseline，
   命中不了就抛 `client-modules: require("…") missed the module table`。
   UI 只能自己写：复制宿主控件的 markup/CSS、类名前缀化、只保留 `--dsw-alias-*` 变量。

## 三、怎么定位

堆栈被吞，所以在 `apply` 里逐段包 `try/catch` 打 `console.error`：

```js
function apply(ctx) {
  let step = 'start';
  try {
    step = 'locale';       /* … */
    step = 'menu-slot';    /* … */
    step = 'overlay-slot'; /* … */
  } catch (error) {
    console.error('[dsh-session-delete] apply failed at step:', step, error);
    throw error;
  }
}
```

浏览器 console 里拿到 `apply failed at step: menu-slot Error: slot "…" is not declared`
之后，问题就收敛了。

排查时用隔离的 `DSH_HOME` 起一个临时实例（不碰生产配置）：

```bash
mkdir -p /tmp/dshsd/profiles/web
cp ~/.dsh/profiles/web/{cordis.yml,package.json} /tmp/dshsd/profiles/web/
ln -s ~/.dsh/profiles/web/node_modules /tmp/dshsd/profiles/web/node_modules
printf -- '- insert:\n    - id: session-delete\n      name: dsh-session-delete\n' \
  > /tmp/dshsd/profiles/web/cordis.patch.yml
DSH_HOME=/tmp/dshsd dsh web --host 127.0.0.1 --port 3098 --no-open
```

注意：bundle URL 里的 `rev` 每个进程固定一次，**改完必须重启进程**，刷新页面没用。

## 四、顺带修掉的两个小问题

- `<style>` 原本塞在插槽组件里，导致菜单的可访问名变成整段 CSS 文本
  （实测 `menu ".dshsd-item-wrap{…}"`）。改成在 `apply` 里
  `ctx.effect` 注入 `<style data-plugin-css>`。
- 弹窗标题为空时回退到「未命名会话」，不再显示裸 sessionId。

## 五、验证

在 rc.5 的隔离实例上端到端通过：会话行「⋯」→ 置顶 / 重命名 / 分叉 / 归档 /
复制 Session ID / **删除会话** → 弹窗「永久删除此会话？」→ 确认 → 磁盘上的会话目录
消失、侧栏行同步消失、页面其余部分正常；`node test/offline-checks.mjs` 全绿。
