# 隐私说明 · Privacy

Translucid（透译）是一个本地运行的浏览器扩展。它没有自己的服务器、不收集遥测、不做统计分析。下面列出的是扩展会发出的**全部**网络请求和会保存在本机的数据。

Translucid is a browser extension that runs locally. It has no server of its own and collects no telemetry or analytics. Below is the **complete** list of network requests it makes and the data it keeps on your device.

## 会离开浏览器的数据 · Data that leaves your browser

| 何时 · When | 发往 · Sent to | 内容 · What |
|---|---|---|
| 翻译网页时 · Translating a page | 你选择的正文 / 短文本服务商（DeepSeek、智谱、Z.ai、Gemini、OpenCode、OpenRouter、NVIDIA、Anthropic Claude 或你自定义的 OpenAI 兼容接口） · The LLM provider you selected | 当前可见段落的文字、页面标题、扩展生成的一句话主题和命中的术语；以及你的 API Key（只发给该服务商）。正文放在铺满页面的内嵌页面（iframe）里时，只有在你为这个页面点了「翻译此页」（或快捷键、右键菜单），或为这个网站设置了「总是翻译」后，才会读取它的段落；全局「自动翻译」只作用于网页本身，不进入内嵌页面。小于 500×400 的框架、已知的广告 / 验证码 / 支付 / 视频 / 社交挂件 / 登录服务域名的框架和编辑器从不读取；框架里出现扩展能识别的登录或支付输入框（密码框，以及按类型、名称、标签或提示文字识别的一次性验证码、银行卡号、安全码、有效期等）时不翻译，已开始的翻译立即停止 · Visible paragraph text, page title, a generated topic line and matching glossary terms; your API key (to that provider only). When a page renders its body in a page-sized frame, that frame's paragraphs are read only after you translate the page (popup, shortcut or context menu) or set the site to always translate; global auto-translate covers the page itself, not embedded frames. Frames smaller than 500×400, frames from known ad / captcha / payment / video / social / sign-in domains, and editors are never read; a frame showing sign-in or payment fields the extension recognizes (password fields, and one-time codes, card numbers, security codes or expiry dates recognized by type, name, label or placeholder) is not translated, and translation already running there stops |
| 主服务商失败且设置了「备用」时 · When the main provider fails and a fallback is set | 你设置的备用服务商 · Your fallback provider | 同上 · Same as above |
| 长页面翻译启用预处理时（「自动」模式达到长度阈值，或设为「总是」） · Preprocessing enabled for long-page translation (automatic length threshold or Always) | 你选择的正文服务商 · Your main LLM provider | 页面正文开头约 6000 个字符（可能包含尚未滚动到的部分）、页面标题，以及你的 API Key；用于提取主题和术语 · The first ~6000 characters of page text, including parts not yet scrolled into view, the page title, and your API key; used to extract the topic and glossary |
| 开启免费机翻（默认关闭）时 · With free machine translation enabled (off by default) | Google（`translate.googleapis.com`）或 Microsoft（`edge.microsoft.com`） | 短的界面文字（按钮、菜单），不带 API Key。这两个是**非公开接口**，可能随时变动，使用受对方条款约束 · Short UI strings, no key. These are **unofficial endpoints** and subject to the vendors' terms |
| 生成站点语言包时 · Generating a site language pack | 你的正文服务商（不会用机翻） · Your main LLM provider (never machine translation) | **只有你在审核页勾选、并在预览中确认过的界面文字**，加上帮助理解的界面结构（例如「对话框 Settings › 分区 General › 问题 Transcript width」，结构标签同样只用已批准的文字）、你确认的应用描述和语言包术语表，以及应用名和 hostname（域名）。不发送完整 URL、页面标题或正文 · **Only the UI strings you ticked and confirmed in the preview**, with their interface structure (screen › section › question, using approved strings only), plus the app description and pack glossary you approved, the app name and hostname. No full URL, page title or page content |
| 点「根据已勾选文字生成描述」时 · "Draft description" button | 你的正文服务商 · Your main LLM provider | 预览中确认的已勾选界面文字、应用名和 hostname（域名）；不发送完整 URL、页面标题或正文 · The ticked UI strings confirmed in the preview, the app name and hostname; no full URL, page title or page content |
| 使用 DeepSeek 且站点为「自动识别」时 · DeepSeek with region "auto" | `api.deepseek.com/user/balance` | 你的 DeepSeek API Key（用于识别国内站 / 国际站计价） · Your DeepSeek key, to tell CNY and USD accounts apart |
| 在设置页点「获取最新免费模型」时 · "Fetch free models" in Options | `openrouter.ai/api/v1/models` | 无（公开列表，不带 Key） · Nothing (public list, no key) |

各服务商如何处理收到的数据由其隐私政策决定，请自行查阅（例如 [Anthropic](https://www.anthropic.com/legal/privacy)、[Google Gemini API](https://ai.google.dev/gemini-api/terms)、[OpenRouter](https://openrouter.ai/privacy)，其他服务商见其官网）。

How each provider handles what it receives is governed by its own privacy policy and terms.

### 一键扫描 · One-click scan

「一键本地化此站点」会在当前网页里自动打开导航分区、菜单和下拉列表来找界面文字，就像你自己点开一样。扩展本身不会因此发送任何数据，但**网站自己的服务器会看到这些正常的页面浏览和请求**（例如打开设置分区时加载的数据），通知之类可能被标为已读。扫描不点击保存、删除、发送、分享、购买这类按钮，不改设置；一旦检测到设置值变化会立即停止并恢复。每个网站第一次扫描前会请你同意，并记住你的选择。

"One-click localize" opens the site's navigation sections, menus and dropdowns in the current tab to find interface text, as if you clicked them. The extension sends nothing because of it, but **the website's own servers see these ordinary page views and requests**, and things like notifications may be marked as read. The scan never clicks save, delete, send, share or purchase controls and changes no settings; if a setting value changes it stops and restores. You are asked once per site before the first scan.

## 只保存在本机的数据 · Data kept only on your device

- **设置与 API Key**：保存在浏览器的 `chrome.storage.local`，**未加密**。任何能访问你浏览器配置文件的人或程序都可能读取。请不要在共用电脑上保存 Key。· Settings and API keys live in `chrome.storage.local`, **unencrypted**.
- **翻译缓存**：IndexedDB，最多约 6 万条，按最近使用淘汰；可在设置页一键清空。· Translation cache in IndexedDB (LRU, ~60k entries), clearable in Options.
- **用量统计**：每月的请求数、token 数和估算费用。· Monthly request/token/cost counters.
- **站点语言包**：你批准并生成的界面译文、圈选的区域选择器。· Site language packs: approved UI translations and region selectors.
- **语言包候选区**：扫描、日常学习（可关闭）或圈选时找到、尚未审核的界面文字，以及它所在的界面结构（界面、分区、问题标签和一个结构哈希）。会话列表、消息、正文、账户名和邮箱等内容不会被收集；不存网址、路由或参数；30 天后自动过期，可随时清空；**不会被导出，也不会自动发送**。· Pending candidates found by scans, everyday learning (can be turned off) or region picking, with their interface structure (screen, section, question label and a structural hash). Chat lists, messages, page content, account names and emails are not collected; no URLs; they expire after 30 days and are never exported or sent automatically.
- **「不再收集」列表、扫描记录与同意记录**：你选择不再收集的文字；最近一次扫描的结果（次数、打开过的界面名称，30 天后删除）；你同意过扫描的网站域名。· Strings you chose never to collect, the last scan report (counts and interface labels, deleted after 30 days), and the sites you allowed to be scanned.

## 导出与分享 · Export and sharing

导出语言包时会自动清洗：只保留已批准、未过期的条目，去掉时间戳，移除疑似邮箱、网址、电话、@用户名、指向个人内容的条目，以及含个人信息的位置标签、区域选择器、术语和备注，并在下载前给你看完整内容和移除清单。分享前请再检查一遍。

Exported packs are scrubbed (approved, non-stale entries only; timestamps removed; suspected personal data removed) and shown to you in full before download. Please review before sharing.

## 权限说明 · Permissions

- `<all_urls>` 主机权限：在你打开的网页上提取并显示译文，并向你配置的服务商发起请求。· To read and render page text and to call the providers you configure.
- `storage` / `unlimitedStorage`：保存设置、缓存和语言包。· Settings, cache and packs.
- `scripting`：只在有站点语言包的网站上注入界面译文脚本；在你点「一键本地化」或「调整范围」时注入扫描或圈选工具。· To run the language-pack script only on sites that have a pack, and the scan or region picker when you start them.
- `tabs`、`contextMenus`：弹出菜单与右键菜单。· Popup and context menu.
