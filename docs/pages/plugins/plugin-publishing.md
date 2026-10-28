# 插件开发：发布与一键安装

把插件放到 GitHub 上，别人就能在设置里粘贴地址一键安装。这里讲仓库怎么放、发布前查什么、怎么发新版本。

把插件放到 GitHub 公开仓库，别人在 **设置 → DSH Tavern → 插件** 粘贴仓库地址即可安装。

## 仓库结构

插件文件直接放在仓库根目录：

```text
dsh-tavern-hello/
├─ package.json
├─ index.mjs      宿主侧，必须有（只做界面也放一个空的）
├─ client.js      浏览器侧，可选
└─ assets/        静态资源，可选
```

```json
{
  "name": "dsh-tavern-hello",
  "version": "1.0.0",
  "description": "一句话说明",
  "type": "module",
  "exports": { ".": "./index.mjs", "./client": "./client.js" },
  "dsh": { "client": { "platform": "web", "inject": ["dsh-tavern-plugin"] } }
}
```

- `name`、`version`、`description` 显示在用户的插件列表里。
- `"platform": "web"` 照写，桌面版、安卓、命令行版通用。
- 没有 `client.js` 时，去掉 `"./client"` 和 `dsh` 字段。

## 要求

- **不写 `dependencies`**：不会安装 npm 包，用到的库请打包进仓库。
- **设置用 `savePluginData` 存**：更新会整体替换插件文件夹。密钥用 DSH 的 `credentials`。见[媒体与数据](#plugin-api-data)。

## 版本

有 Release 时，安装和更新取最新 Release；没有时取默认分支。用户的插件列表会把 Release 标签（如 `v0.2.2`）和 `package.json` 的 `version` 比较：标签更新时才显示「更新到 …」，相同则显示「已是最新」。发布 Release 时记得同步提高 `version`，否则用户看不到更新。插件更新后需要重启 DSH 才会加载新代码；刷新页面只更新浏览器侧。

## README 安装说明

```markdown
## 安装

打开 DSH Tavern → 设置 → DSH Tavern → 插件，粘贴本仓库地址，点「安装」，刷新页面。
连不上 GitHub 时，下载本仓库 ZIP，在同一处点「上传 ZIP」。
```

发布前在自己的酒馆里按这段装一次，列表显示「已加载」即可。
