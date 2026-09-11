# dsh-terminal-tab

给 DSH Web GUI 加一个**终端**标签页，和「对话」「轨迹」同级。终端里可以跑 `nvim`，也可以跑任何终端程序（`lazygit`、`htop`、`ssh`……）。

- 每个会话一个终端进程，切换标签页或刷新页面不会杀掉它（有重连宽限期）。
- 终端跑在 dsh 服务进程里（node-pty + ConPTY），浏览器里是 xterm.js。
- 只有一个 host 路由：`/terminal-tab/ws`，升级前先过同源/回环信任检查。

## 安装

### 方式一：本地开发（推荐，不经过 pnpm 依赖解析）

```powershell
cd D:\repos\dsh-plugins\dsh-terminal-tab
npm install --ignore-scripts     # 只装构建期依赖
npm run build                    # 产出 lib/index.js 与 lib/client.js
npm test                         # 25 项冒烟检查
```

然后把构建产物放进 profile，并在 profile 的补丁层挂载：

```powershell
# 1) 复制包到 profile 的 node_modules
$dst = "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-terminal-tab"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item package.json, cordis.patch.yml, README.md, lib, src -Destination $dst -Recurse -Force
```

```yaml
# 2) 编辑 %USERPROFILE%\.dsh\profiles\web\cordis.patch.yml，把 [] 替换为：
- insert:
    - id: terminal-tab
      name: 'dsh-terminal-tab'
```

3. 浏览器里**硬刷新**（Ctrl+Shift+R）。

profile 声明了 `"patchReload": "live"`，补丁层的改动会热加载 host 半边；客户端 bundle 是页面启动时按 `window.__DSH_BOOT__` 清单取的，所以必须刷新页面。

这么做的好处是：`node-pty` 和 `ws` 由 dsh 安装本身提供，pnpm 不需要再去装一份原生的 node-pty。

### 方式二：作为 bundle 安装（用于分发）

```powershell
npm pack                                                    # 产出 dsh-terminal-tab-1.0.0.tgz
dsh plugin --profile web add .\dsh-terminal-tab-1.0.0.tgz   # 装依赖 + 追加到 dsh.profile.bundles
```

这条路径下 pnpm 会按 `dependencies` 装 `node-pty`（原生模块，可能需要 `pnpm approve-builds`）和 `ws`，然后 `cordis.patch.yml` 里的 `insert` 行自动生效。

### 方式三：从 GitHub 装

```powershell
dsh plugin --profile web add github:TomDan-GodsHand/dsh-terminal-tab#v1.0.0
```

git 安装拿到的是**源码不是构建产物**，所以本包带了 `prepare` 脚本（`node build.mjs`）在安装后自行构建。pnpm ≥10 默认不允许执行依赖的构建脚本，第一次 `add` 会失败并打印要放行的包名——把它抄进 profile 的 `pnpm-workspace.yaml` 再重跑：

```yaml
allowBuilds:
  dsh-terminal-tab: true
```

建议带上 tag 或 commit（`#v1.0.0` / `#<sha>`），否则以后一次 push 会悄悄改变安装内容。

## 版本管理

- **版本号**：标准三段 semver `<major>.<minor>.<patch>`。当前 `1.0.0`，对应 git tag `v1.0.0`。
- `package.json` 里 `private: true`，所以不会误发布到 npm；真要发布时把它去掉即可（版本号本身是合法 semver，`npm publish` 接受）。
- **每个版本**：改 `package.json` 的 `version` → 在 `CHANGELOG.md` 顶部加一条 → `git commit` → `git tag v<version>` → push（带 tags）。
- 历史改动与"为什么"都记在 [`CHANGELOG.md`](CHANGELOG.md)；提交历史按功能切分，不混入无关格式化。

## 配置

配置写在挂载行的 `config` 里，全部可选：

```yaml
- insert:
    - id: terminal-tab
      name: 'dsh-terminal-tab'
      config:
        command: nvim          # 直接起一个命令而不是 shell
        shell: pwsh.exe        # 或指定 shell
        cwd: D:\repos
```

| 键 | 默认值 | 说明 |
|---|---|---|
| `command` | `''` | 非空时直接启动该程序（如 `nvim`）；为空则启动 shell |
| `commandArgs` | `[]` | `command` 的参数 |
| `shell` | `''` | shell 可执行文件；为空按平台推断 |
| `shellArgs` | `[]` | 为空时：POSIX 用 `-l`，Windows 不加参数 |
| `cwd` | 服务进程工作目录 | 终端初始目录；浏览器也可以用 `?cwd=` 覆盖（必须是存在的绝对路径） |
| `maxPerSession` | `3` | 每个会话的终端上限 |
| `reconnectGraceMs` | `30000` | 浏览器断开后终端保留多久 |
| `transcriptLimit` | `262144` | 断线重连时回放多少字节历史输出 |

Windows 下 shell 推断顺序：`config.shell` → 环境变量 `DSH_TERMINAL_TAB_SHELL` → 找到的 `pwsh.exe` → `powershell.exe`。`command` 如果是裸名字（`nvim`），会按 `PATH` + `PATHEXT` 展开成完整路径——Windows 的进程创建不保证自己做这件事。

上面这些是**组合层**的默认值。你在设置页里改的 `shell` / `command` 会盖在它们之上（见下节）；其余键只能从这里配。

## 设置页（设置 / 插件 / 插件设置 → Terminal）

卡片叫 **Terminal**，不叫「终端」——插件设置页本来就有一张自己的「终端」卡片（`shell` 命名空间，管的是 bash 工具的超时与输出上限），所以这张按它配置的对象命名，避免两张卡片撞名。

它和那一列里的其它卡片长得一样：圆角边框的一行、点整行展开、标题下压一行灰色说明、右侧箭头（展开时转 180°）。样式是照内置 `PluginCard` 的编译产物对齐的（同样 16px 圆角 / `0.5px` 边框 / 15px 标题 / 13px 说明 / `--dsw-alias-*` token）。

host 半边注册了一个设置命名空间 `dsh-terminal-tab`，浏览器半边在 `settings.plugin.item` 槽里用同一个 key 挂了一张卡——插件设置页渲染的正是「host 提供的命名空间」和「注册进来的卡片」的交集，所以这个 key 相等是两者唯一的配对方式。

| 项 | 说明 |
|---|---|
| **终端 Shell** | 下拉可选 `auto` / `pwsh` / `powershell` / `cmd` / `bash`，也可以直接填可执行文件路径。`auto` = 平台推断（本机解析到 `C:\Program Files\PowerShell\7\pwsh.exe`） |
| **启动命令** | 填了就绕过 shell 直接启动它（例如 `nvim`） |
| **字体** | CSS 的 `font-family` 列表（逗号分隔，可加引号），带 6 个常用等宽字体候选；默认 `'Cascadia Mono', Consolas, 'Courier New', monospace`。列在第一的没装就依次回退，中文字形由系统字体补 |
| **字号** | 6–32 px 的整数；越界会标红并禁用「保存」 |
| **界面颜色** | 背景、文字、光标、选中背景；每个色块旁边是**可编辑的色值框** |
| **ANSI 颜色** | 8 个基础色（黑红绿黄蓝品红青白），下面有一条用当前配色渲染的**实时预览** |

颜色有两种改法：点色块用系统取色器，或者**直接在色值框里填/粘贴 HEX**（支持 `#aabbcc`、`aabbcc`、`#abc`，`#` 可省、大小写都行，填完失焦即生效）。填了不合法的会还原成原来的颜色，不会写进配置——所以半截的色值永远到不了终端。
| **恢复默认** | 暂存一次「清空整个用户层」，每项回到组合层 / schema 默认值，点「保存」才写入 |

**默认配色是白底浅色**（避免和常见深色终端一样）：背景 `#ffffff`、文字 `#24292f`、ANSI 取每个色相**较深**的一端（红 `#cf222e`、绿 `#1a7f37`、黄 `#9a6700`、蓝 `#0969da`……），这样在白底上都有足够对比度——浅色终端最常见的毛病就是沿用深色主题的亮色 ANSI，在白底上糊成一片。

行为：

- **暂存 + 保存/放弃**（和内置卡片同一套）：控件只改本地草稿，标题栏出现「未保存」标记，底栏「保存」写入、「放弃」丢弃；保存中按钮禁用，写失败显示「保存失败，未写入。」并保留草稿可重试，保存成功后卡片自动收起。
- 写入是**按路径的差分**（只写真正变化的字段），不是整段替换——设置视图是脱敏的，整段替换会删掉没返回给你的字段。
- **字号和颜色是实时的**：卡片和终端标签页读同一个绑定好的 settings scope，保存后终端视图立刻重绘。
- **Shell 和启动命令对新开的终端生效**，已经在跑的终端保持原进程（不会莫名把你正在用的 shell 换掉）。想立刻用新 shell 就点「重开终端」。
- 值持久化在 `$DSH_HOME/settings.yaml` 的 `dsh-terminal-tab:` 段里，可以直接手改。
- 两半对设置服务的依赖不同：host 半边把 `settings` 当可选（`ctx.inject`），没有它照样提供终端，只是没有设置页；浏览器半边把 `settingsScope` 写进 `inject`，所以一个没有 compose 设置域的 GUI 里这个插件不会激活。本 GUI 的设置域是 web-app 的一部分，始终在。

## 用法

打开「终端」标签页就是一个 shell，**终端铺满整个视图**：没有工具栏，没有内外边距，下面的**输入框（composer）在终端标签页激活时会被隐藏**。

- 想跑 nvim 就在终端里敲 `nvim`（退出后 shell 和环境都还在），或者把设置里的**启动命令**填成 `nvim`，让标签页一打开就进 nvim。
- 不要原来的「nvim / 重开终端」按钮了：一个动作在 shell 里本来就能做，另一个（重开）等价于 `exit` 后让视图自动重连。
- 连接提示不占版面：断线重连或启动失败时，消息以气泡形式浮在终端底部，不挤压终端高度（否则每次重连都会让终端跳动一下）。
- 隐藏输入框用的是这两条规则（同一个选择器组）：

  ```css
  body:has(.dshTerminalTabRoot) [data-composer-seat],
  body:has(.dshTerminalTabRoot) [data-width-handle] { display: none }
  ```

  `data-composer-seat` 是外壳包住 composer 槽的那层；`data-width-handle` 是它两侧那两条**整列拖拽条**（3px 渐变竖线，hover 才显形，用来拖聊天列宽）。两者是**兄弟节点**，只藏 seat 的话那两条会横在终端上——因为它们的位置是按聊天列宽算的，而 composer 没了之后那个宽度没有意义。两个钩子都用外壳自己的 `data-*`，**不依赖任何被哈希过的 CSS 类名**。
- 「同一时刻只渲染选中的那个 view」，所以「我的 view 在场」就等于「终端标签页是当前页」，切回「对话」输入框和拖拽条立刻回来。要发消息就切到「对话」标签页。

## 工作原理

```
浏览器 xterm  ──WS /terminal-tab/ws──▶  host 插件  ──node-pty──▶  ConPTY / pty
   (lib/client.js)                        (lib/index.js)
```

**浏览器半边**通过 `ctx.slots.inject('conversation.view', …)` 注册一个条目：`id: 'terminal'`、`order: 20`、`label: '终端'`。`conversation.view` 就是「对话」和「轨迹」所在的标签环（`kind: 'list'`、`scope: 'session'`），由 `@deepseek-ai/dsh-client-ui-conversation` 声明；轨迹用的是 `order: 10`，所以终端排在它后面。

**host 半边**只注册一个 WebSocket 升级路由：

```ts
ctx.effect(() => ctx.webServer.registerUpgrade({
  path: '/terminal-tab/ws',
  handler: (request, socket, head) => {
    if (!isTrustedRequest(request, trustedHosts())) { socket.destroy(); return }
    wss.handleUpgrade(request, socket, head, (ws) => attachTerminal({ ... }))
  },
}))
```

会话在查询串里：`?sessionId=<id>&tab=main&cols=120&rows=40`。

### 线上协议

两个方向都是文本帧，大部分是原始终端字节：

| 方向 | 帧 | 含义 |
|---|---|---|
| host → 浏览器 | 任意文本 | 终端输出（连上时先回放历史，最后一条是 `[进程已退出，代码 N]`） |
| 浏览器 → host | 任意文本 | 当作键盘输入写给 pty |
| 浏览器 → host | `{"type":"resize","cols":n,"rows":n}` | 改窗口大小 |
| 浏览器 → host | `{"type":"close"}` | 立即结束进程 |
| 浏览器 → host | `{"type":"park"}` | 保留进程（页面卸载时用） |

规则是：能解析成**已知** JSON 控制对象的算控制帧，其它一律当输入——所以你在 shell 里敲 `{"type":"x"}` 不会被吃掉。安全上限：socket 积压超过 4 MiB 就丢输出而不是排队。

### 安全

`/terminal-tab/ws` 是能拿 shell 的入口，而 GUI 的路由分发在鉴权兜底之前，插件路由不带页面的 token，所以插件自己做信任检查（`src/trust-fence.ts`，与 web `/api` 网关同一套规则）：

- `Host` 必须是回环（`localhost` / `[::1]` / `127.0.0.0/8`）或配置过的可信 host；
- 带 `sec-fetch-site: cross-site` 的拒绝；
- 带 `Origin` 时必须和 `Host` 同名主机。

这是防 DNS rebinding / 跨站的措施，**不是鉴权**：同一台机器上任何进程都能连。和 `dsh-better-sidebar` 的终端是同一套模型。

## 开发

```powershell
npm install --ignore-scripts
npm run build      # rolldown 打包：lib/index.js（ESM）+ lib/client.js（CJS 工厂包）
npm run typecheck  # tsc --noEmit
npm test           # node test/smoke.mjs
```

构建工具用 `rolldown` 而不是 esbuild：rolldown 的原生绑定在本进程内运行，不 fork 服务子进程；esbuild 需要一个通过管道通信的服务进程，在被限制管道的环境里会 `EPERM`。

`lib/client.js` 不是普通 ESM，而是 GUI 模块加载器要的形状：

```js
window.__ModuleLoader__.load({ id: "dsh-terminal-tab", factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  // …打包后的插件代码（xterm 内联在这里）…
  return module.exports; } });
```

它只对 `react` / `react/jsx-runtime` 发起 `require`——这两者和 shell 的冻结模块表里的其它条目一样由页面提供，其余依赖（xterm、插件自身代码）全部内联。所以 `package.json` 的 `dsh.client` 不需要 `external`。

### 测试覆盖到什么

`test/smoke.mjs`（32 项）用假 socket + 假 pty + 假 ctx 跑真实源码，覆盖四块：

- **协议与工具函数**：控制帧解析、尺寸钳制、shell/命令推断（含 Windows `PATH`+`PATHEXT` 与 shell 关键字）、信任检查、设置载荷在 wire 边界的归一化。
- **socket 协议全链路**：历史回放、输出转发、按键写入、resize/close/park、断开后的宽限关闭。
- **host 装配**：`apply()` 确实注册了命名空间 `dsh-terminal-tab`（带上组合层 base）和 `/terminal-tab/ws`、`/terminal-tab/diagnostics` 两条路由；设置 schema 能 `toJSON()`、能给默认值、能合并已存值、会拒绝越界字号——这几步是打桩的注册调用覆盖不到的；自检端点会报告加载的构建与客户端图里的行。
- **浏览器产物**：在 `vm` 沙箱里真正求值 `lib/client.js`，用严格的 `require` 断言它只请求基线模块（`react`/`react/jsx-runtime`/`ui-primitives`），断言两个槽条目：`conversation.view`（`terminal` / `order 20` / 「终端」）和 `settings.plugin.item`（`key` = 设置命名空间）；断言**保存时算出的差分路径写**（只写变化字段、`恢复默认` 先 unset section 根、没改动就不写）；还有一条静态断言：**绑定 hook 必须带选择器**（漏了会让整个槽条目在渲染时崩，这个回归真发生过）。

**没有覆盖的**：真实 PTY 的创建，以及浏览器里的实际渲染。agent 沙箱禁掉了 ConPTY 需要的命名管道，`node-pty` spawn 会 `EPERM`；已验证的是 dsh 服务进程里能正常开 PTY（用已装插件自己的 socket 实测，回显到了标记）。卡片/标签页在页面上的渲染，只能靠浏览器确认。

## 已知限制

- **xterm 是随 `lib/client.js` 一起加载的**（约 400 KB）。sidebar 的做法是把终端单独打成懒加载 chunk，这里为了少一条自有路由和内嵌一套 chunk 加载器，暂时没做。若启动开销在意，这是第一个该改的地方。
- **一个会话一个终端**（`tabId` 固定 `main`）。多终端需要把 `tabId` 提升成真正的标签集合。
- **shell 与启动命令不在运行中的终端上生效**，改完要么等下次打开，要么点「重开终端」。
- **字体只暴露字号**，字体族没做成设置项。
- **单字段没有「恢复继承」**：内置卡片每个字段旁能单独清掉 override，这里只有整卡片的「恢复默认」。要做需要按字段显示"已被覆盖"并暂存一次 unset。
- **没有回滚缓冲清理策略**：`transcriptLimit` 之外的输出丢弃。
- 信任检查不是鉴权（见上）。
- 终端以 `process.cwd()` 或配置的 `cwd` 启动，不跟随会话工作区。
