# macOS 后台组件

在仓库根目录运行 `pnpm run build:native`。脚本使用系统 Swift 编译器生成并本地签名 `native/build/Whale Computer.app` 和仅用于测试的 fixture。DSH 安装包只交付前者。

组件通过标准输入输出接受宿主请求。辅助功能用于读取控件和执行语义操作，屏幕录制权限仅用于已授权的截图。光标通过不接收鼠标事件的 AppKit 窗口绘制。需要测试特定系统与前后台行为时，应在该系统上验收。

[原生协议](../PROTOCOL.md) · [第三方许可](THIRD_PARTY_NOTICES.md)
