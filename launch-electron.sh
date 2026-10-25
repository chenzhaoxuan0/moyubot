#!/usr/bin/env sh
# MoyuBot 桌面客户端启动（unix 版；Windows 对应 launch-electron.bat）
unset CDPATH # 防 CDPATH 劫持 cd 进错目录、跑错仓库的 package scripts
cd "$(dirname "$0")" || exit 1
echo "正在启动 MoyuBot 全栈服务与桌面客户端..."
exec pnpm dev:desktop
