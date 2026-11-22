# 验收方式

`pnpm test` 运行测试目录中的 Node 测试；macOS GUI、权限提示等需要显式选择的原生场景会显示为跳过。可用 `WHALE_TEST_CHROMIUM` 指定测试浏览器的可执行文件。仓库 CI 采用 macOS 环境，执行构建、静态检查和默认测试。

## Chrome 真机引擎测试

先执行 `pnpm run build:client`。设置 `WHALE_TEST_CHROMIUM` 为支持加载未打包扩展的 Chrome for Testing 可执行文件。以下指令使用独立配置，保留日常 Chrome 的标签和设置。

```sh
WHALE_TEST_HEADLESS=1 node scripts/accept-browser-extension.mjs
WHALE_TEST_VIDEO=/path/to/local-film.mp4 WHALE_FORM_ARTIFACTS=/path/to/results node scripts/accept-enhanced-playback.mjs
```

长时用例请提供至少 50 秒的本地 MP4。测量包括初次后台播放、超过 30 秒后的实际进度、切入同一播放器、光标像素以及停止后的调试连接释放。带 `--public-bilibili` 时，第二条指令会在无登录的临时配置访问真实网站；站点状态会影响结果。

首次使用回归覆盖空配置、手动停止跨重启、会话唤醒、缺少浏览器扩展时的工具回执，以及安装包中原生组件的执行权限。离线视频验收同时记录 DSH 工具入口的延迟。

0.4.0 已在 Apple Silicon macOS、DSH 0.2.2-rc.3 / rc.5 的测试环境构建和回归。此前双扩展的日常桌面采样记录不计入此单扩展版的验收。

<a id="build"></a>
## 在 macOS 从源码构建

需要 Node.js 22.19+、pnpm 10.24.0 和 Xcode Command Line Tools。在仓库根目录执行：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build:client
pnpm run build:native
pnpm run check
pnpm test
pnpm pack
```
