#!/usr/bin/env bash
# 一次性端到端验证：agent 经 aw CLI 全量操作定时任务与待办（临时 home + 独立端口，不碰真实数据）
set -u
cd "$(dirname "$0")/.."
TMPHOME=$(mktemp -d)
TMPWIN=$(cygpath -w "$TMPHOME")
export AGENT_WORKBENCH_HOME="$TMPWIN"
export AGENT_WORKBENCH_PORT=5399
URL=http://127.0.0.1:5399
AWM="$PWD/../cli/bin/aw.mjs"

cleanup() {
  # daemon.stop 之外的第二道保险：按端口找 PID 强杀（Windows 进程树）
  local pid
  pid=$(netstat -ano | grep "TCP.*:5399.*LISTENING" | awk '{print $5}' | head -1)
  if [ -n "$pid" ]; then taskkill //F //PID "$pid" //T >/dev/null 2>&1; fi
  rm -rf "$TMPHOME"
}
trap cleanup EXIT

awrun() {
  node "$AWM" --url "$URL" --token "$TOKEN" "$@"
  local rc=$?
  echo "[exit=$rc]"
  return $rc
}

fail=0
step() { echo ""; echo "=== $1"; }

echo "daemon booting (home=$TMPWIN)"
npx tsx src/index.ts > "$TMPHOME/daemon.log" 2>&1 &
DPID=$!
ok=""
for i in $(seq 1 40); do
  if curl -s -o /dev/null "$URL/healthz"; then ok=1; break; fi
  sleep 1
done
[ -z "$ok" ] && { echo "daemon 未在 40s 内就绪"; tail -20 "$TMPHOME/daemon.log"; exit 1; }
sleep 1
TOKEN=$(cat "$TMPHOME/token")

step "automation add（--in 30，一次性）"
awrun automation add --unit e2e --root "$TMPWIN" --runtime zcode --prompt "端到端测试任务" --in 30 --name "e2e 定时" || fail=1

step "automation list"
awrun automation list || fail=1

step "automation off --id 1 / on --id 1"
awrun automation off --id 1 || fail=1
awrun automation on --id 1 || fail=1

step "automation runs --id 1"
awrun automation runs --id 1 || fail=1

step "automation add 缺调度应报用法错（exit 2）"
awrun automation add --unit e2e --root "$TMPWIN" --runtime zcode --prompt x
rc=$?
[ $rc -eq 2 ] || { echo "(期望 exit 2，实际 $rc)"; fail=1; }

step "automation rm --id 1"
awrun automation rm --id 1 || fail=1

step "automation list（删后应为空）"
awrun automation list

step "backlog add / list"
awrun backlog add --goal "e2e 待办目标" --unit e2e --root "$TMPWIN" --title "e2e 待办" || fail=1
awrun backlog list || fail=1

step "daemon.stop"
awrun call daemon.stop || fail=1

echo ""
echo "=== 结果：$([ $fail -eq 0 ] && echo ALL PASS || echo FAIL) ==="
exit $fail
