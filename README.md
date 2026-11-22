<p align="center"><img src=".github/media/minke.png" alt="Minke 鲸鱼娘抱着箭头光标" width="96"></p>

<h1 align="center">Minke</h1>

<p align="center">DeepSeek Harness 的 macOS 电脑控制插件。鲸鱼娘会跟着 AI，标出它正在点的按钮。</p>

<p align="center"><a href="https://github.com/heerte869-droid/minke/releases/download/v0.4.9/local-dsh-whale-computer-0.4.9.tgz"><strong>下载 DSH 插件 ↓</strong></a>　·　<a href="#install">安装方法</a>　·　<a href="https://github.com/heerte869-droid/minke/releases">所有版本</a></p>

![实机录制：DSH 在 macOS 计算器中按键算出 168 × 3 = 504，并在 Chrome 中展开本项目的 GitHub Release 资产列表，指向 DSH 安装包。](.github/media/minke-in-action.gif)

<details>
<summary>看 Chrome 表单实操：把 3 个住宿选项筛到 1 个</summary>

![DSH 在 Chrome 本地酒店演示表单选择 Marina District、早餐和办公桌，点击搜索后选中 Luma Harbor Hotel。](.github/media/chrome-hotel.gif)

</details>

<a id="install"></a>
## 装进 DSH

1. 下载上方的 **`.tgz` 安装包**，保留压缩格式。
2. 打开 DSH 左侧的 **插件 → 添加插件**，粘贴该文件的完整路径，点 **安装**。在 Mac 的访达里选中文件，按 `⌥⌘C` 即可复制路径。
3. 需要操作 Chrome 时，在 DSH 的 **设置 → 电脑控制 → 安装 Chrome 扩展** 中取得扩展目录。到 Chrome 扩展管理页开启开发者模式，点 **加载已解压的扩展程序**，选择该目录。

<details>
<summary>查看 DSH 安装窗口</summary>

<img src=".github/media/dsh-install.png" alt="DSH 添加插件窗口，在输入框填写本地 tgz 路径后点击安装" width="560">

</details>

适用 Apple Silicon Mac、macOS 14+、DSH 0.2.2-rc.3 / rc.5；Chrome 扩展需要 Chrome 118+。Windows / Linux 已通过 Chromium 适配自动化检查，尚未在这两个系统的 DSH 桌面端实测。

[浏览器连接与权限](docs/EXTENSION.zh.md) · [工具接口](docs/API.md) · [从源码构建](docs/TESTING.md#build) · [MIT 许可](LICENSE) · [素材与第三方说明](THIRD_PARTY_NOTICES.md)
