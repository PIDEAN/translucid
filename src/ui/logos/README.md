# 服务商官方 SVG

核对与获取日期：2026-10-04（`anthropic.svg` 为 2026-10-11）。所有资源直接来自服务商官方站点或官方 GitHub 仓库，随扩展一起打包，不从 CDN 动态加载。Logo 的商标权归各自服务商所有。

| 文件 | 官方来源 | 处理说明 |
| --- | --- | --- |
| `deepseek.svg` | [DeepSeek 官方仓库](https://github.com/deepseek-ai/DeepSeek-LLM/blob/main/images/logo.svg) · [原始 SVG](https://raw.githubusercontent.com/deepseek-ai/DeepSeek-LLM/main/images/logo.svg) | 提取鲸鱼图形，去掉字标及其裁剪定义；保留原始 path 与蓝色，viewBox 调整为图形区域。 |
| `glm.svg` | [智谱官网 SVG](https://www.zhipuai.cn/logo.svg) | 提取官方组合 Logo 的三个 Z 图形 path，去掉中文文字；保留原始路径与黑色。 |
| `glm-global.svg` | [Z.ai 官方站点 SVG](https://chat.z.ai/static/logoLight.svg) | 使用官方浅色界面版本；将 `.cls-*` 的 fill 样式转为 SVG 属性，避免内联样式影响其他 Logo。保留渐变及原始多边形。 |
| `gemini.svg` | [Google Gemini 官网](https://gemini.google/about/) | 提取页头内联字标中的彩色星芒，保留原始 mask、路径、颜色与 filter 定义。纯矢量，无嵌入位图；采用官网彩色版本。 |
| `opencode-zen.svg` | [OpenCode 官方品牌页](https://opencode.ai/brand) · [官方资源包](https://opencode.ai/opencode-brand-assets.zip) | 使用品牌页 SVG 下载按钮提供的 `opencode-logo-light-square.svg`，保留原始方形图形、颜色、遮罩与裁剪。 |
| `opencode-go.svg` | [OpenCode 官方品牌页](https://opencode.ai/brand) · [官方资源包](https://opencode.ai/opencode-brand-assets.zip) | 与 Zen 共用同一官方 OpenCode 标志；服务通过名称区分。 |
| `openrouter.svg` | [OpenRouter 官方品牌页](https://openrouter.ai/brand) · [官方透明 SVG](https://openrouter.ai/brand/v2/openrouter-glyph-light.svg) | 使用官网当前紫色 glyph；将 class fill 展开为属性以免影响其他 SVG，保留原始路径、viewBox 和 #7624F4。不添加背景形状或白色底板。 |
| `nvidia.svg` | [NVIDIA 官网](https://www.nvidia.com/en-us/) | 提取页头内联 SVG 的绿色 Eye Mark path，移除字标，viewBox 裁剪到图形区域；保留官方路径与 #76B900。不添加背景形状或白色底板。 |
| `anthropic.svg` | [Claude 官网 favicon](https://claude.ai/favicon.svg)（与 claude.com 同一文件） | Claude 星芒标志，单个 path，保留原始路径与 #D97757；仅去除固定 width/height。 |

去除固定 width/height，由 `providerLogo()` 设置实际尺寸并通过默认 `xMidYMid meet` 保持比例。文件本身只做了图形提取、去掉字标和把 class 样式展开为属性（`glm-global.svg`），没有重绘路径或改动颜色；但**显示时**会在 Logo 外加白色底板和留白（OpenRouter、NVIDIA 除外，保持透明背景），以便在深色主题中看清。

## 使用依据与商标

- 这些 Logo 只用于在设置页和弹出菜单中**标识对应的服务商**，表明本扩展可以接入该服务（指示性使用），不表示与这些公司存在合作、认可或赞助关系。
- 所有商标和 Logo 归各自权利人所有。
- **OpenRouter、OpenCode**：取自官方品牌页提供下载的素材。
- **DeepSeek、智谱、Z.ai、Google Gemini、NVIDIA、Anthropic Claude**：取自官方网站或官方仓库公开的文件，**未获得明示授权**。这些公司的品牌规范可能限制第三方使用；如果权利人提出要求，我们会立即移除。
- 想完全避免使用官方 Logo：删除本目录中对应的 `.svg`，界面会自动回退到 `src/ui/brand.ts` 里的自绘徽标（`tests/brand.test.ts` 中「每个具名服务商都有官方矢量」的断言需同步调整）。

`src/ui/provider-logos.ts` 构建时导入这些文件，为每次渲染重命名 SVG ID 及对应引用，避免同页多处 Logo 的渐变、mask 和 clipPath 互相干扰；同时剔除 script、foreignObject 与 on* 事件属性。

更新文件后执行 `pnpm compile && pnpm test && pnpm build`，再在扩展管理页刷新扩展。
