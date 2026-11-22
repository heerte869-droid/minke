# Third-party notices and provenance

Computer Use is an independent project. It is not an OpenAI, DeepSeek, or Apple product and is not endorsed by them. The project uses supplied raster whale-girl artwork in its PNG cursors and toolbar icons. The project owner has authorized public distribution of these images with this repository and its release packages. The MIT license applies to the code; no separate license for standalone reuse of the character artwork is specified.

## Dependencies (not relicensed by this project)

- DeepSeek Harness SDK packages, `@deepseek-ai/*`, versions 0.2.2-rc.3 and 0.2.2-rc.5; Cordis 4.1.0; Schemastery 3.19.0. Refer to the MIT licenses and notices in their distributed packages. They are peer/runtime dependencies. The two components embedded in the settings bundle are listed with their notices below.
- Playwright Core, Microsoft Corporation, Apache License 2.0. Installed through the package manager; its complete license and notices remain in the dependency package. Browser binaries are not bundled.
- Apple macOS system frameworks (AppKit, ApplicationServices, ScreenCaptureKit, Vision, CoreGraphics): used through system APIs, not redistributed.

## Research only

The local `research/dsh-sdk` directory contains extracts from the user's installed DSH application for version-specific interface research. It is NOT included in the installable package or source release. Public OpenAI documentation was used to understand desired interaction behavior; no proprietary Codex code, plugin text, images, icons or binaries are redistributed.

Public design references: Anionex/dsh-computer-use (MIT), ZRui-C/dsh-computer-use (Apache-2.0), trycua/cua (component-dependent licenses), openclaw/Peekaboo (MIT). A reference alone does not imply code was copied or its guarantees independently verified. The optional native SkyLight routing recipe has been adapted; its provenance, copyright and complete MIT license are in `native/THIRD_PARTY_NOTICES.md`, included in the package. It is disabled by default and has not yet been empirically validated on real applications.

No OmniParser/AGPL perception component is used. OCR uses the operating system's Vision framework.

## Test-only OpenAI CUA sample labs

The unmodified booking, kanban and paint lab sources under test/fixtures/openai-cua come from https://github.com/openai/openai-cua-sample-app at commit 6dd34b40acc1d002696ccd41aaf0a1f2f2be290c (MIT). The upstream LICENSE and SOURCE.json are retained beside the test fixtures. These labs are not shipped in the runtime package. No Codex desktop driver source was copied.

## Licenses embedded in the settings bundle

### @deepseek-ai/dsh-typert-protocol 0.2.2-rc.3

MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### zod 4.6.6

MIT License

Copyright (c) 2025 Colin McDonnell

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Minke README media

The project mascot logo was generated for Minke. The main recording shows the DSH tools operating the macOS Calculator and this project’s public GitHub release in Chrome. The additional form recording uses the local Northstar Stays booking lab credited above. The setup image is a capture of the running DSH plugin installer. Product names and application interfaces belong to their respective owners.
