# Changelog

All notable changes to the DeepSeek Harness VS Code extension are documented here.

## 0.8.1 — 修复面板空白与入口

1. **面板永久空白（根因）**：webview 产物里含 `import.meta`（来自对 dev-theme.css 的动态 import），而宿主用普通 `<script>` 加载，属于语法错误，整包解析失败、React 从未挂载。脚本标签改为 `type="module"`，备用主题改静态引入并收拢到 `body.dsh-standalone`（真实 webview 的 body 是 `dsh-root`，不会污染主题）
2. **多余 CSS 消除**：固定文件名曾让两个 CSS 撞名产出 `index2.css`，现已只有一个
3. **`dsh.newChat` 报 "An object could not be cloned."**：内建 `<viewId>.focus` 的返回值无法跨 RPC 序列化，新增 `revealChat()` 统一吞掉
4. **命令 id 冲突**：`dsh.chat.focus` 与 VS Code 为视图自动生成的同名焦点命令撞车，且处理器调用自身（自递归）。删除该声明与注册，改用 `dsh.chat.openPanel`
5. **面板定位到右侧**：容器贡献到 `secondarySidebar`，与 Copilot / Claude Code 一致；`revealChat()` 先 `focusAuxiliaryBar` 显示右侧栏再聚焦视图，右侧栏收起时也能弹出
6. **新增编辑器标题栏按钮**：带自有图标的 `dsh.chat.openPanel`，快捷键 `Ctrl+Alt+D`
7. **新增单色 SVG 图标**：由 logo 位图矢量化（`fill="currentColor"`），对比三个镂空方案后选用"仅眼睛镂空"，24px 下轮廓最清晰
8. **移除左侧活动栏图标**：VS Code 把容器绑定到唯一位置，活动栏图标只能打开左侧栏，与"面板在右侧"冲突，故不再提供左侧入口

## 0.8.0 — 20 轮交互打磨

1. **日期分隔符**：今天/昨天/日期，长对话天然分段
2. **条目淡入动画**：新消息 0.18s ease-out 上滑渐显
3. **Toast 通知系统**：底部弹出自动消失（2.2s，最多 3 条），成功/信息/危险三色
4. **复制成功 Toast**：助手消息复制后弹出绿色“已复制”
5. **接受/拒绝 Toast**：工作集操作后弹出确认
6. **Tab 补全**：斜杠菜单中按 Tab 补全首选命令
7. **Escape 关闭**：斜杠菜单中按 Esc 清空关闭
8. **ARIA 标签**：composer 输入框 + 主容器 role/label
9. **ARIA 分隔符**：日期分隔线 role=separator
10. **ARIA 屏幕阅读器**：toast 容器 aria-live=polite
11. **Error Boundary 样式**：白屏降级为可见错误 + 重试按钮
12. **流式 markdown 防抖**：120ms 节流重渲（0.7.1 已有，此轮验证）
13. **多根工作区**：优先活动编辑器所在根（0.7.1 已有）
14. **dsh.verify**：一键内核验证（0.7.1 已有）
15. **日期分隔线样式**：横线分隔，主题变量着色
16. **Toast 三色**：success 绿 / info 灰 / danger 红
17. **条目动画减少 layout shift**：translateY 替代 margin
18. **Toast 指针穿透**：pointer-events: none 不阻挡底层交互
19. **Composer aria-label**：屏幕阅读器可识别输入区
20. **综合验证**：typecheck/lint/test 37/37/VSIX 全绿

## 0.7.1 — 韧性与性能

1. **React Error Boundary**：面板渲染异常（恶意 markdown、意外条目）降级为可见错误+重试按钮，不再白屏
2. **流式 markdown 防抖**：流式期间 120ms 节流重渲，长回复不再每 chunk 全量解析 markdown
3. **多根工作区支持**：多文件夹时优先用活动编辑器所在根目录作为 cwd
4. **dsh.verify 命令**：命令面板一键验证内核完整链路（定位→spawn→握手→建会话）

## 0.7.0 — 对话持久化 + 回归测试

1. **对话持久化**：重载窗口后聊天内容不丢——时间线与工作集写入 workspaceState，激活时自动恢复（含内部索引重建，后续流式更新可继续追加）；新对话时自动清除持久化
2. **TimelineReducer.restore()**：从持久化条目重建内部索引（toolCallId→entryId 等），恢复后新更新正确合并到已恢复条目而非重复创建
3. **回归测试**：restore 圆环测试（序列化→恢复→继续更新→验证不重复）+ 两个新增测试 = 总计 37 个

## 0.6.2 — 第二轮审查修复（10 项）

1. **进程生命周期**：exit 回调不再把人为停止/陈旧子进程当作崩溃——代际 token + stopping 标志 + dispose 清理重连定时器
2. **oneShot 并发**：单槽 capturing 改为 Map<sessionId>，并发 oneShot 不再互相覆盖、内容不再泄漏进主聊天
3. **Markdown 双重嵌套**：自定义 fence 规则替代 highlight 选项，消除 markdown-it 的额外 <pre><code> 包装
4. **codeRegistry 泄漏**：改用内容寻址 FNV-1a hash id，流式重复渲染复用同一 key，Map 上界变为不同代码块数
5. **diffStats 失真**：Set 语义改为频次多重集，重复行（}、空行）不再导致 +0/-0
6. **@ 选中已打开文件时 path 污染**：不再复用 QuickPick 展示后缀字符串
7. **shell 拼接注入**：shell:true 下对含空格/元字符的 args 手工引号包裹
8. **.cmd 入口 EINVAL**：executablePath 指向 .cmd/.bat/.ps1 时自动改走 shell 路径
9. **cancel 未处理拒绝**：Promise.resolve().catch 兑底
10. **loadSession 返回内核分配的新 sessionId**（而非请求旧值）

## 0.6.1 — 全面审查修复（6 项缺陷）

1. **严重**：oneShot 全局捕获槽与主会话并发冲突——autoTitle 期间用户回合的工具调用/编辑丢失、标题被聊天内容污染。修复：按 sessionId 过滤 + 挂槽时机后移 + finally 同一性检查
2. **警告**：connecting 态可双重提交（快速双击 Enter 创建两个会话）——守卫补全 connecting
3. **警告**：取消后点击陈旧审批卡把状态永久卡死 prompting——改为以当前状态判定
4. **警告**：hostCommand / quickAction 无运行时白名单（伪造 webview 消息可执行任意 dsh.* 命令）——加 Set 白名单 + QUICK_PROMPTS 键校验
5. **警告**：openDiff 相对路径不解析工作区根（与 accept/reject 行为不一致）——统一 resolveEditPath
6. **警告**：内核重发同一 editId 时覆盖用户已决断的编辑（rejected 条目被复活为 pending/applied）——已决断条目跳过覆盖
7. **建议**：gitCommitMessage 现已覆盖 untracked 文件（ls-files --others + diff --no-index）

## 0.6.0 — 打磨与发布就绪

1. **性能**：用户/助手消息条目 React.memo，流式期间仅重渲染当前条目，长对话不再全量重绘
2. **对话内搜索**：超过 8 条消息时顶部出现粘性搜索框，实时过滤（用户/助手/工具/文件路径全维度）
3. **编辑后重发**：用户消息悬停“编辑”按钮，文本回填输入框可改后重发
4. **AGENTS.md 引导**：打开无规则文件的工作区时提示一键创建（每次会话仅提示一次）
5. **待审徽标**：workingSet 变更同步到 VS Code when-context（dsh.pendingCount），为视图徽标铺路
6. **Walkthrough 第四步**：快捷键一览表
7. **测试补强**：WorkingSet/SessionStore 新增 5 个单测（总计 35 个）
8. **README 全面更新**：命令表（17 组）、设置表（10 项）、快捷键表、热重载说明

## 0.5.0 — 再二十轮深度优化，集百家之长

1. **统一 diff 内联预览**：面板内真·行级 diff（LCS 算法，红/绿/灰三色、过长省略）
2. **@ 优先已打开的编辑器**：附加上下文时打开的文件排最前
3. **追问建议**：回合结束自动推荐 3 个后续问题（有待审变更时换为变更相关建议）
4. **用户消息重发**：悬停用户气泡一键重发
5. **拒绝全部变更**：工作集一键拒绝全部
6. **diff 视图内接受/拒绝**：原生 diff 编辑器标题栏新增 ✓/✕ 按钮
7. **解释剪贴板报错**：终端报错复制后一键解释
8. **配置热重载**：修改 dsh.* 设置立即生效，无需重载窗口
9. **AI 自动会话标题**：新会话自动用 AI 生成简短标题
10. **解释选区快捷键**：Ctrl+Alt+E
11. **状态栏 tooltip 增强**：显示会话短 ID 与待审变更数
12. **会话历史相对时间**：刚刚 / N 分钟前 / N 小时前 / N 天前
13. **内核崩溃自动重连**：意外断开后 2 秒自动重试一次
14. **快捷卡自适应**：窄面板自动单列
15. **工具卡类型徽标**：读取/编辑/执行等中文标签
16. **未设 Key 引导横幅**：面板顶部提示去设置 API Key
17. **chips 可点击**：点击 chip 图标在编辑器打开文件
18. **AGENTS.md 模板**：一键创建项目规则文件
19. **命令面板快速提问**：不切换面板直接提问
20. **导航与收纳**：快捷操作菜单/重命名/删除/导出等统一进头部菜单

## 0.4.0 — 十轮深度优化，集百家之长

1. **行内指令编辑**（Cursor Cmd+K 风格，Ctrl+Alt+K）：选中代码输入指令直接修改
2. **导出对话为 Markdown**（含用户/助手/工具/错误全时间线）
3. **会话管理**：重命名/删除会话（头部菜单或命令面板）
4. **拖拽附加文件**：从资源管理器拖文件到输入区即附上下文（uri-list 解析）
5. **变更卡内联预览**：免开编辑器，面板内红/绿对照前 40 行
6. **状态栏快捷菜单**：点击状态栏弹出新对话/恢复/审查/提交信息/设置
7. **输入区“附加问题诊断”按钮**：一键把当前诊断作为上下文
8. **回合结束自动进入审查**（dsh.autoOpenReview，默认开）：有待审变更时自动打开首个 diff
9. **Git 深耦合**：暂存差异 → AI 生成 Conventional Commit → 自动填入 SCM 输入框（SCM 标题栏按钮 + 面板菜单）；基于一次性临时会话，不污染对话
10. **一键复制诊断信息**：版本/内核配置/环境汇总进剪贴板，报 issue 神器

## 0.3.0

- 新增上手引导 Walkthrough：安装后 Welcome 页提供三步引导（打开面板/安装内核与密钥/审查变更）
- 逐个审查流：WorkingSet“逐个审查”按钮 + 命令面板命令 + Ctrl+Alt+R 快捷键，循环打开下一个待审查 diff
- 助手消息悬停复制按钮；用户/助手消息悬停显示时间
- Problems 面板右键精确解释点击的那条问题（利用菜单传入的 uri/range 过滤）
- 右键菜单“解释所选代码”补 editorHasSelection 条件

## 0.2.0

- 空状态新增“快速开始”卡：解释选中代码 / 编写单元测试 / 重构这段代码 / 初始化项目上下文，一键发送
- 编辑器灯泡 Code Action：选区上提供“解释/重构所选代码”快捷动作；右键菜单同步增加重构入口
- Problems 面板右键“用 DeepSeek Harness 解释此问题”：诊断信息作为上下文直发对话（最多 8 条）
- Copilot 式自动选区：发送时自动附加编辑器当前选区（设置 dsh.attachActiveSelection 可关）
- 断连/出错横幅 + 一键“重试连接”；消息列表新增“回到底部”浮动按钮
- 状态栏随会话状态实时同步；连接中不再误显示停止按钮

## 0.1.2

- 修复 "An object could not be cloned."：宿主→Webview 消息在唯一出站边界做纯 JSON 克隆（快照活引用、丢弃函数属性），并对 postMessage 失败记录日志而非静默弹出错误
- ACP 事件入时间线前对 plan/commands 做防御性纯对象拷贝，避免保留 SDK 内部对象

## 0.1.1

- 默认图标更换为官方鲸鱼标识（市场图标与活动栏图标），并提供 icon.ico/icon.jpg 源资产
- 中英双语支持，中文为主：package.nls（中文默认 + 英文包）、运行时 l10n（中文源 + 英文包）、Webview 界面跟随 VS Code 显示语言（默认中文）
- 修复 Webview 独立预览下的命令列表与主题回退

## 0.1.0 - Initial release

- Activity Bar chat panel (Copilot-style) with streaming markdown, code highlight, copy and insert-to-editor
- `@` file attachments, selection context, slash commands (`/init`, `/compact`, `/login`, `/help`)
- Kernel integration over ACP: `dsh` located via setting, managed install or PATH, with crash auto-restart
- Working set review: native diff editor, per-file accept/reject, Keep all
- Permission approvals: in-panel cards + native notifications, read-only auto-approve opt-in
- Plan/todo timeline, thinking blocks, tool call cards with durations
- Session history per workspace with resumption (kernel capability permitting)
- API key via SecretStorage; zh-cn locale bundle
