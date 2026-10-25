import type { ToolExecutionData } from "../types.ts";
import { BashToolCard } from "./BashToolCard.tsx";
import { FileDiffToolCard } from "./FileDiffToolCard.tsx";
import { SearchToolCard } from "./SearchToolCard.tsx";
import { GenericToolCard } from "./GenericToolCard.tsx";

export function ToolCardHost({ data }: { data: ToolExecutionData }) {
  const name = (data.toolName || "").toLowerCase();

  // 1. 终端与命令行执行
  if (
    name.includes("terminal") ||
    name.includes("bash") ||
    name.includes("exec") ||
    name.includes("command") ||
    name === "run_command"
  ) {
    return <BashToolCard data={data} />;
  }

  // 2. 文件修改与差异
  if (
    name.includes("file") ||
    name.includes("write") ||
    name.includes("replace") ||
    name.includes("patch") ||
    name.includes("diff")
  ) {
    return <FileDiffToolCard data={data} />;
  }

  // 3. 联网搜索
  if (
    name.includes("search") ||
    name.includes("web_search") ||
    name.includes("browse") ||
    name.includes("fetch_url")
  ) {
    return <SearchToolCard data={data} />;
  }

  // 4. 通用长尾工具兜底
  return <GenericToolCard data={data} />;
}
