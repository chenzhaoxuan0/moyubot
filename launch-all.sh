#!/usr/bin/env sh
# agent-workbench 全栈启动（unix 版；Windows 对应 launch-all.bat）
cd "$(dirname "$0")" || exit 1
echo "正在启动 agent-workbench 全栈服务与桌面客户端..."
pnpm dev:desktop
