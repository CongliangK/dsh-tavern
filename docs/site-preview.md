# 贡献指南

欢迎给 DSH Tavern 提 PR！文档网站和酒馆程序都在同一个仓库里。不需要先成为开发者，也不需要做一个大功能：你使用时觉得哪里难懂、难找、麻烦，都可以从那里开始改。

## 哪些贡献都欢迎

- 改错字、补漏掉的步骤、修失效链接，把看不懂的说明改成人话。
- 写小白教程：从安装、配置模型到导入人物卡、开始第一局，告诉读者点哪里、填什么、成功后会看到什么。
- 给配置项、按钮或菜单改名，让人不用猜就知道它有什么用；补一句说明或一个例子也很好。
- 把不常用、复杂的配置放进默认折叠的“高级设置”，减少第一次使用时需要面对的选项。
- 调整界面布局、默认值和操作流程，改善手机体验、键盘操作或可读性。
- 修复 Bug、完善兼容性、补充示例、开发插件，或者提出新的功能。

这些只是例子。任何能让酒馆更好用、更容易理解的改动，都欢迎提出。小改动可以直接提 PR；涉及较大功能或行为调整时，可以先开 Issue 聊聊，也可以先提交草稿 PR 讨论。

## 内容在哪里维护

文档站由源文件生成，**不要直接编辑 `docs/index.html`**，否则下次构建会覆盖修改。

| 想改什么 | 源文件 |
| --- | --- |
| 产品概览、安装与启动 | [docs/manual/introduction.mjs](manual/introduction.mjs) |
| 各功能的介绍、操作步骤、结果和注意事项 | [docs/manual/topics.mjs](manual/topics.mjs) |
| 目录顺序、分组与各部分概览 | [docs/manual/navigation.mjs](manual/navigation.mjs) |
| 功能标题、入口和简述 | [docs/feature-inventory.md](feature-inventory.md) |
| 插件开发、人物卡教程 | `docs/plugin-*.md`、`docs/dshcard-guide.md`、`docs/dshcard-tutorial.md` |
| 本篇贡献指南 | [docs/site-preview.md](site-preview.md) |
| 文档外观和手机排版 | [docs/assets/manual.css](assets/manual.css) |
| 文档搜索、主题与页面切换 | `docs/assets/manual-state.js`、仓库根目录的 `manual.js` |
| 文档生成方式 | [docs/manual/build.mjs](manual/build.mjs) |
| 酒馆里的配置名称、界面和交互 | `tavern-plugin/src/client/`，可先搜索当前显示的文字 |

教程尽量围绕一个具体目标写清前提、步骤和结果。现有主题使用稳定地址，例如 `#b07`（正文重写）；改标题时尽量保留地址，让别人分享过的链接继续可用。

## 修改现有功能说明

在 `docs/manual/topics.mjs` 中，按功能编号找到对应的 `page(...)`。参数依次是：简介、操作步骤数组、结果与生效范围、注意事项、相关功能编号数组。例如：

```js
A03: page(
  '文字模型负责生成故事。',
  ['打开左侧设置 → 模型。', '填写服务地址和密钥，选择模型并保存。'],
  '保存后，可以使用这个模型开始游玩。',
  '不要分享 API 密钥。',
  ['A04', 'M01']
),
```

生成器会自动加上“在哪里”“如何使用”“结果与生效范围”等标题，不用在参数里重复写。页面标题和入口来自 `docs/feature-inventory.md`；如果改的是这些文字，也要同步修改清单。`A01` 产品概览和 `A02` 安装页的正文由 `introduction.mjs` 提供，不使用 `topics.mjs` 中的正文。

写步骤时用当前界面上的实际名称，先写点哪里，再写要做什么。新手教程先帮助读者完成一次操作，低频选项和原理放后面，并说明哪些可以跳过。改名或折叠配置的程序改动，也欢迎同步补齐文档中的名称和入口。

## 增加教程或独立页面

独立教程通过 `docs/manual/navigation.mjs` 的 `extraPages` 注册。正文可以直接写在 `content` 中，也可以复用已有 Markdown 文件，通过 `developerDoc('文件名.md')` 读取；文件路径相对 `docs/`。仅把 Markdown 放进目录，不会自动出现在网站上。

下面以读取已有 Markdown 的贡献指南为例：

```js
{
  id: 'contributing',
  title: '贡献指南',
  group: 'help',
  intro: '欢迎一起完善文档和使用体验。',
  content: developerDoc('site-preview.md')
},
```

`id` 是唯一的页面地址，例如 `#contributing`；使用小写字母、数字和连字符。`group` 要使用现有分组 ID，例如 `play`、`cards`、`plugins` 或 `help`。

产品分组中的独立页面会自动出现在对应侧栏目录中；`help` 不在产品分组侧栏里，需要在帮助概览中添加正文链接，或像贡献指南一样在 `build.mjs` 的侧栏底部添加入口。新增页面后确认读者能从目录或相关页面找到它。

如果复用 Markdown 文件，在 `navigation.mjs` 顶部的 `sitePages` 中补上文件名到页面 ID 的映射，例如 `'site-preview.md': 'contributing'`，让其他 Markdown 指向它的相对链接转换为站内链接。

如果增加的是功能清单中的主题，则同时在 `feature-inventory.md` 增加唯一编号，在 `topics.mjs` 添加内容，并把编号加入 `navigation.mjs` 对应分组的 `chapters`。相关功能数组填写大写编号（如 `A04`），正文链接使用小写地址（如 `#a04`）。

## 正文格式、链接和截图

网站使用 `build.mjs` 中的轻量 Markdown 渲染器，并不支持完整 Markdown 语法。现有可用格式包括普通段落、二三级标题、单层有序／无序列表、表格、单行引用、围栏代码块、粗体、行内代码和链接。不要依赖原始 HTML、嵌套列表或 Markdown 图片语法；原始 HTML 会被转义。

Markdown 文件开头的一级标题会由 `developerDoc()` 移除，网站使用注册的 `title` 显示页面标题。正文从二级标题开始，例如：

```md
## 开始之前

先配置好文字模型，其他高级设置可以暂时跳过。

## 操作步骤

1. 打开人物卡库。
2. 导入人物卡，再选择新建游玩。

也可以先阅读[开始第一局](#a04)。
```

站内链接写成 `[开始第一局](#a04)`，外部链接使用完整的 `https://` 地址。通过 `developerDoc()` 读取的 Markdown 相对链接，会优先按 `sitePages` 转成站内地址，其余转到 GitHub 源文件。直接写在 JavaScript 字符串中的正文，使用站内锚点或完整 HTTPS 链接。

正文写在 JavaScript 字符串中时，注意引号与换行的转义；使用模板字符串时，正文里的反引号和 `${...}` 也需要转义。

截图文件放在 `docs/images/manual/`，在 `docs/manual/screenshots.mjs` 的 `screenshots` 中登记文件名、说明、替代文字和来源，再通过 `pageScreenshots` 将截图关联到页面 ID。照着已有条目填写即可，图片会由生成器插入页面。截图请使用公开样例，去掉密钥和私人对话。

## 本地预览文档

只改文档站时，需要 Node.js 22.19 或更新版本；下面的预览命令还需要 Python 3。文档构建使用 Node.js 内置模块，不需要先安装整个酒馆的依赖。

在仓库根目录执行：

```sh
node docs/manual/build.mjs
python3 -m http.server 4173 --bind 127.0.0.1 --directory docs
```

浏览器打开 `http://127.0.0.1:4173/`。每次改完源文件，重新运行构建命令，再刷新浏览器；这不是自动热更新服务。预览结束后，在终端按 Ctrl+C 停止。

提交前运行文档相关检查：

```sh
node --test tests/manual-site.test.mjs tests/product-site.test.mjs tests/manual-pages.test.mjs
```

如果已经安装 pnpm，也可以使用 `pnpm docs:dev`、`pnpm docs:build` 和 `pnpm test:docs`。本地构建更新了受跟踪的 `docs/index.html` 时，请把生成结果和源文件一起提交。

修改布局或交互时，再用浏览器看看电脑和手机窄屏下的效果，检查链接、搜索和浅色／深色主题。只改文档无需运行全部酒馆测试；修改程序时，运行与改动相关的测试，并在 PR 中说明验证结果。

## 发布

文档改动合并到 `main` 后，会触发仓库的 `Publish documentation` 工作流，构建检查通过并部署成功后更新网站。无需单独配置 GitHub Pages 或手动上传页面。
