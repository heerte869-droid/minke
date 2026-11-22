# Chrome 浏览器控制

## 日常使用

首次使用请打开 DSH「设置 → 电脑控制」，点「安装 Chrome 扩展」。在自动打开的 Chrome 扩展管理页开启开发者模式，点「加载已解压的扩展程序」，选择设置页显示的目录。可用「复制目录」，并在 macOS 文件选择器按 ⌘⇧G 粘贴。扩展文件已经随 DSH 插件提供。DSH 和扩展通过当前用户的 Chrome Native Messaging 主机连接。待命时可以从对话发起支持的后台任务；其他 HTTPS 网页可由用户在扩展弹窗选择「共享当前页」。弹窗会显示当前任务标题、站点和状态，「停止共享」会释放连接并保留网页。

单个视频搜索通常复用未选中的 DSH 任务页。当前任务页正被用户观看时，新的搜索会另开后台标签。用户要求比较多个结果时，DSH 可以在同一个窗口和任务分组里保留几页。

## 从双扩展迁移

0.4.0 将浏览器控制和后台播放合为一个扩展，并沿用主扩展原有的 ID。先从 DSH 设置获取新版 ZIP，解压到长期保存的位置。更新原主扩展并接受 Chrome 提示的新增调试权限；确认版本为 0.4.0、DSH 可以自动调用后，即可停用或移除旧的「DSH · 后台视频播放」0.1.0。新版不会调用旧组件。初次安装只需加载一个目录。

## 权限

| Chrome 权限 | 用途 |
| --- | --- |
| `activeTab`、`scripting` | 在用户共享或任务已授权的标签中观察控件、执行操作和绘制光标。 |
| `nativeMessaging` | 连接本机 DSH，在会话中接收任务和返回结果。 |
| `storage`、`tabGroups` | 维护当前共享和 DSH 创建的任务分组。 |
| `contextMenus` | 工具栏右键菜单中的「停止共享」。 |
| `debugger` | 让 DSH 的未选中视频任务标签保持可渲染。Chrome 授予该扩展调试其他标签的技术能力，安装时会提示。 |
| B 站主站及搜索站的 HTTPS 主机权限 | 允许 DSH 从对话自动建立任务并搜索。其他普通网站使用用户点选的单页授权。 |

后台呈现只在 DSH 自建、未选中、由当前扩展静音的 B 站视频任务标签上启动。扩展固定使用 `Emulation.setFocusEmulationEnabled`，将操作绑定到已观察文档和原播放器。遇到观看限制、导航、视频结束、用户取消调试或任务停止会解除连接。扩展没有接受网页或其他扩展提供调试命令的接口。Chrome 的权限模型规定 `debugger` 只能声明为必需权限。[Chrome 权限文档](https://developer.chrome.com/docs/extensions/reference/api/permissions)

## 排查连接

「未连接」可能是首次安装，也可能是 Chrome 尚未打开。「等待 Chrome 加载」表示目录已经准备好。成功连接后会自动显示「可自动调用」或「已共享」。「已断开」时打开之前启用扩展的 Chrome 配置即可重连。如果同时打开多个已配置的 Chrome 配置，请在目标页选择共享。

电脑控制默认开启。只有主动停止后才需点击「恢复操作」。辅助功能、屏幕录制和输入监控分别由 macOS 管理，按需要使用的原生功能授权。

0.4.4 的静音播放使用已共享普通标签的 Chrome 静音开关。播放期间保持该标签静音；可在 Chrome 中手动恢复声音。使用播放工具可以保留后台音轨，网站自己的暂停、媒体解码错误和无音轨视频仍可能中断。

0.4.8 的 whale_open_extensions 可在用户要求配置 Chrome 扩展时，在普通窗口的非活动标签中打开管理页，保留当前选择。需要一个已连接的普通配置。返回值仅说明标签已创建；后续加载、授权和配对分别核验。

<a id="WindowsLinux"></a>
## Windows / Linux

安装同一 DSH 插件。在独立的 Chrome 测试配置启动本机调试后，将调试地址填入「设置 → 电脑控制 → 浏览器调试连接」。例如使用端口 9222 时填 `http://127.0.0.1:9222`。模型可用 `whale_browser` 列出标签、观察网页和操作控件。

Windows PowerShell（Chrome 位于默认安装目录时）：

```powershell
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 "--user-data-dir=$env:LOCALAPPDATA\DSH-Chrome"
```

Linux：

```sh
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.config/dsh-chrome"
```

对已打开的 OpenAI 账单概览，模型可用 `whale_observe_billing` 检查当前标签状态和页面显示的美元余额。首次在扩展弹窗中按需授予 platform.openai.com 的站点访问权限。读取只针对唯一的官方账单概览；未发现明确余额时返回原因。站点授权可在 Chrome 扩展设置中撤回。
