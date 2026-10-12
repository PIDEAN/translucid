# 致谢 · Acknowledgements

Translucid 的设计参考了下面这些项目和研究中的**思路**。本项目没有复制它们的代码或提示词原文；提示词和实现均为原创。

Translucid's design draws on **ideas** from the projects and research below. No code or prompt text was copied from them; prompts and implementation are original.

| 来源 · Source | 借鉴的思路 · Idea borrowed |
|---|---|
| [Immersive Translate](https://immersivetranslate.com/)（沉浸式翻译）公开的 prompt 设计 | 把「输出协议」和「领域规则」分层：协议由代码固定，场景专家只写少量领域规则 · Separating a fixed output protocol from short domain rules |
| [Read Frog](https://github.com/mengxi-ream/read-frog) | 在批量翻译中不使用「跳过哨兵」示例，避免模型滥用导致漏翻 · Not showing skip sentinels in examples |
| [KISS Translator](https://github.com/fishjar/kiss-translator)、[FluentRead](https://github.com/Bistutu/FluentRead) | 网页段落提取、上下文放在任务之前并标为只读参考 · Paragraph extraction; context placed before the task as read-only reference |
| [BabelDOC](https://github.com/funstory-ai/BabelDOC)、VideoLingo | 先做一次轻量预处理（主题、术语）再翻译 · A light preprocessing pass (topic, terms) before translating |
| [translation-agent](https://github.com/andrewyng/translation-agent)（Andrew Ng）与论文 TEaR（Translate, Estimate, and Refine） | 手动「精翻」的「翻译 → 自查 → 改进一轮」两步流程；以及多轮迭代会累积错误、实时翻译只调用一次的结论 · The two-step translate-then-refine flow for manual refinement |
| [pangu.js](https://github.com/vinta/pangu.js) 所代表的排版惯例 | 中文与拉丁字母、数字之间加空格（本项目为独立实现） · CJK–Latin spacing convention (independent implementation) |
| [Mozilla Readability](https://github.com/mozilla/readability) | 提取正文用于页面预处理（作为依赖使用，Apache-2.0，见 THIRD_PARTY_NOTICES） · Used as a dependency for article extraction |

端到端测试的 fixture 页面使用 [Base UI](https://base-ui.com/) 与 [Radix UI](https://www.radix-ui.com/) 组件（MIT，仅作开发依赖，不打包进扩展），用来在真实的组件行为下验证扫描、关闭弹层和圈选。页面结构参照常见生产力工具的通用模式自行编写，没有复制任何网站的代码或资源。

End-to-end fixture pages use Base UI and Radix UI components (MIT, dev dependencies only, not shipped) to test scanning, popup dismissal and picking against real component behaviour. The page structures are written from common patterns; no site's code or assets were copied.

第三方依赖的许可证见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。服务商 Logo 的来源与商标说明见 [src/ui/logos/README.md](../src/ui/logos/README.md)。
