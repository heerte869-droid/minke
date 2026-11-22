<img src="browser-extension/icons/dsh-128.png" alt="" width="72">

# Whale Computer Use for DSH

让 DeepSeek Harness 在 macOS 上操作原生应用和 Chrome。鲸鱼娘光标标出 AI 操作的位置，你可以继续使用自己的鼠标。

**Native macOS computer use for DeepSeek Harness, with background Chrome automation and a visible AI cursor.**

[下载安装包 · Releases](https://github.com/heerte869-droid/dsh-whale-computer-use/releases/latest) · [工具接口](docs/API.md)

## 安装

已验证 Apple Silicon Mac、macOS 14+ 构建及 DSH 0.2.2-rc.3 / rc.5；原生组件采用 ad-hoc 签名，Chrome 扩展要求 Chrome 118+。

Windows / Linux 提供实验性 Chromium 调试连接，尚未做这两个系统的 DSH 实机验收。[连接方法](docs/EXTENSION.zh.md#WindowsLinux)

1. 在 DSH 插件管理器导入 `local-dsh-whale-computer-0.4.9.tgz` 并启用插件。电脑控制默认就绪，首次任务会自动连接原生组件。
2. 需要使用 Chrome 时，在 DSH「设置 → 电脑控制」点「安装 Chrome 扩展」。DSH 会准备好随包提供的目录并打开 Chrome 扩展管理页。
3. 首次使用在 Chrome 开启开发者模式，点「加载已解压的扩展程序」，选择 DSH 显示的目录。连接成功后 DSH 会自动显示「可自动调用」。旧用户在 Chrome 中重载 0.4.8 即可使用普通页静音续播。

设置顶部的「停止操作」会立即取消任务并记住选择。再次点同一位置的「恢复操作」即可使用。休眠或锁屏时会取消当前操作，回到已解锁会话后可直接发起新任务。[旧版迁移与 Chrome 权限](docs/EXTENSION.zh.md)

## 使用

在 DSH 对话里提出任务，例如「在 B 站找一段熊猫视频，在后台静音播放」。扩展会在原窗口打开未选中的任务页。切入任务页可以观看并看到鲸鱼娘，切回后 DSH 仍可核对播放进度。普通 HTTPS 网页可在扩展弹窗点「共享当前页」交给 DSH；弹窗显示目标标题和站点，可查看任务页或停止共享。

原生应用通过 macOS 辅助功能访问控件。截图与 OCR 按设置和任务需要使用。网页遇登录遮挡、验证或访问限制会停止相应操作。[浏览器权限与行为](docs/EXTENSION.zh.md) · [工具接口](docs/API.md)

## 从源码构建

安装 Node.js 22.19 或以上、pnpm 10.24.0 和 Xcode Command Line Tools。以下命令在仓库根目录执行。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build:client
pnpm run build:native
pnpm run check
pnpm test
pnpm pack
```

`build:client` 同时生成 DSH 设置页和 `assets/DSH-Chrome.zip`。只改 Chrome 扩展时可运行 `pnpm run build:extension`。Native 构建只编译、签名；安装使用上一节的流程。DSH 安装包已包含同一个 Chrome ZIP。

浏览器端到端测试使用临时配置。常规单元测试会跳过需要显式启用的原生设备测试。[验收方式](docs/TESTING.md)

## 许可与来源

本项目由社区独立开发。代码采用 MIT 许可；依赖许可、测试样例以及角色素材的来源见[第三方说明](THIRD_PARTY_NOTICES.md)。
