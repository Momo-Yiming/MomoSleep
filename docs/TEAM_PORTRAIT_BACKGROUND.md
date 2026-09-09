# 团队横幅背景与轮廓光

2026-09-09：本次仅修复团队横幅的背景连续性及人物轮廓光。保留已确认的人物来源、位置、大小和资料。

## 素材与显示方式

- 原始合照：`server/pages/assets/team/team-portrait-hero-v2.png`，保持原文件不变。
- 背景修复素材：`server/pages/assets/team/team-backdrop-restored-v1.png`，由内置 ImageGen 以原合照为编辑目标，移除人物、补全同风格纹理。它不是原始照片中不可见背景的实拍还原。
- 页面 SVG 底层使用修复素材，上层保留原合照。利用原三人的透明轮廓遮罩移除旧人物，按原图尺度扩边 80 像素、羽化 25 像素，让人物周围的补图平滑融入原来可见的蓝色渐变与纹理；不是在中央覆盖纯色矩形。
- Frank 与 Anne 使用已确认的 v3 透明人物；Momo 使用已确认的 v5 透明人物，位置仍为 left 31%、top 16%、width 38%、height 84%。
- 每人只有一个可见人物层。默认、悬停、聚焦和点按不替换照片，仅对当前人物应用同一个柔和蓝色 drop-shadow；模糊半径随横幅宽度缩放。
- 旧 `/team-preview` 入口跳转到正式团队区域，避免再次展示旧版叠图。

## 图像编辑记录

模式：内置 ImageGen；只编辑背景素材，未生成或修改人物。

最终提示词：

> Use case: precise-object-edit. Edit target: the provided original team portrait. Produce ONLY a clean empty background plate for this exact photograph: remove all three people completely (all hair, faces, bodies, hands and clothes), seamlessly reconstruct the concealed dark navy/blue mottled studio backdrop. Preserve the original visible blue backdrop texture, fine photographic grain, color palette, soft illumination, darker corners, and framing as faithfully as possible. This is restoration of the existing background, not a redesign. Match its cloudy fine-grained blue texture continuously across the entire canvas, with no vertical seams or panels, no plain flat gradients, no portrait silhouettes, no glow or halo, no foreground, no text, no new objects. Keep landscape 16:9 composition, output a full opaque backdrop image. The existing people will be composited in website code separately, so the output MUST contain ZERO people.

## 验收重点

原始纹理连续、中央无竖条、旧人物无重影；三人切换前后位置相同且只有选中人物发光；桌面鼠标、键盘和触屏点按均能切换资料；窄屏不出现横向溢出。

本地已验证：Chrome 1440 / 1024 / 768 / 390 / 320 像素宽度、WebKit 1440 / 390 / 320 像素宽度。逐人悬停/点按、默认 Momo、键盘切换、英文资料、素材加载及无横向溢出检查通过；人工回看三人高亮截图，中央色块和旧人物轮廓已消除。WebKit 和窄屏测试是本机浏览器验证，不代表 iPhone 真机验收。

发布后：稳定 Pages 的 Chrome 五种宽度、WebKit 三种宽度复测通过，已再次人工回看三人状态及 390 像素窄屏截图；本地完整服务器测试 14/14 通过，旧预览入口保留语言并跳转正式团队区。此次不可变部署预览：<https://4e6cc25a.smart-sleep-economy-demo.pages.dev/#team>。网站 v1.0 快照保持不变。
