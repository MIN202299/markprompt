# Web Debug Annotator (Chrome 插件)

在任意网页上对元素进行**编号注释**,生成带标记的**全页截图**和可直接粘贴给 AI 的 **Prompt 文本**。

## 功能

- 点击浏览器工具栏图标(蓝色 `message-circle-plus`)→ 页面右上角弹出下拉菜单
  - **开始注释**:图标切为红色 `circle-stop`,鼠标变为填充气泡光标
  - **历史记录**:侧边抽屉展示历史会话,支持查看详情 / 删除单条
  - **清空记录**:弹窗确认后清空全部历史
- 注释模式:鼠标悬停高亮元素,**点击**在点击位置放置「填充气泡 + 序号」标记,标记右侧弹出评论输入框
  - 输入框 `placeholder = 添加评论...`,单行,末尾 `check` 按钮
  - `Enter` 提交 / `Esc` 取消当前注释;空内容提交时输入框**摇晃**
  - 序号从 1 递增,可连续注释
- 注释中再次点击工具栏图标(`circle-stop`)→ 停止注释,自动生成:
  - 带所有编号标记的**全页截图**(滚动拼接)
  - 按指定格式生成的 **Prompt 文本**
  - 以**右侧抽屉**展示本次注释详情:复制 Prompt / 下载 Prompt / 复制图片 / 下载图片 / 查看历史记录
- 历史记录持久化到 `chrome.storage.local`,刷新 / 重启浏览器后仍在

## Prompt 格式示例

```
# Comment 1
Node position: (739, 269) in 1380x1324
Viewport Page URL: http://localhost:3333/#/crowd-select
Target selector: div.ant-table-body:nth-of-type(2) > table > tbody.ant-table-tbody > tr.ant-table-row.ant-table-row-level-0:nth-of-type(3)
Target path: div > table > tbody > tr
Saved marker screenshot: attached as a labeled image for Comment 1
Comment: 这里是评论内容

# Comment 2
...
```

## 安装方法

1. 打开 Chrome,地址栏输入 `chrome://extensions`
2. 右上角打开「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本项目文件夹 `web-debugger`
5. 点击浏览器工具栏中的插件图标(若未固定,可在拼图菜单里找到)

> 注:`chrome://`、`chrome.google.com` 等浏览器内置页面不允许 content script 注入,点击图标无反应属正常。

## 使用流程

1. 打开目标页面
2. 点击工具栏**插件图标** → 下拉菜单选择「开始注释」→ 图标变红、鼠标变气泡
3. 鼠标移到目标元素(蓝色高亮)→ **点击**,气泡标记出现在点击位置,右侧弹出评论输入框
4. 输入评论后按 `Enter` 或点击 `check` 按钮(空内容会摇晃提示)
5. 继续点击下一个元素进行连续注释(序号自动递增)
6. 全部完成后再次点击**工具栏图标** → 生成截图与 Prompt,右侧弹出注释详情抽屉
7. 在抽屉里「复制图片」「复制 Prompt」,一起粘贴到 AI 对话框

## 文件结构

| 文件 | 作用 |
|------|------|
| `manifest.json` | MV3 配置(action 无 default_popup,使点击直达 content script) |
| `background.js` | service worker:工具栏点击转发、lucide 图标渲染与切换、截图 / 下载 |
| `content.js` | 核心逻辑:下拉菜单、注释、标记、评论输入、全页拼接、抽屉、历史存储 |
| `content.css` | UI 样式 |
| `icons/` | 插件默认图标(工具栏图标由 background 动态渲染覆盖) |

## 说明 / 限制

- 工具栏图标由 service worker 用 `OffscreenCanvas + Path2D` 渲染 lucide 路径后通过 `chrome.action.setIcon` 动态切换,无需额外图标资源
- 自定义气泡光标由 content script 用 canvas 生成 PNG data URL 注入
- 全页截图通过滚动 + `captureVisibleTab` 拼接实现,标记随页面滚动,最终落在正确的文档坐标位置
- 截图时自动隐藏菜单 / 抽屉 / 输入框 / 高亮框,但保留编号标记
- 复制图片使用 Clipboard API(`ClipboardItem`),需要 Chrome 较新版本;失败可改用「下载图片」
- 超长页面(总像素超过浏览器 canvas 上限)截图可能失败,属浏览器限制
- 历史记录含截图 data URL,体积较大,已声明 `unlimitedStorage` 权限
- 标记使用绝对定位(文档坐标),若页面 `body`/`html` 设置了 `position` 或 `transform` 可能出现偏移
