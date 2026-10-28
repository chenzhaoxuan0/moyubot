import type { LucideIcon } from "lucide-react";
import { FileCode, Search, Terminal, Wrench } from "lucide-react";
import type { ToolExecutionData } from "../types.ts";
import { BashToolCard } from "./BashToolCard.tsx";
import { FileDiffToolCard } from "./FileDiffToolCard.tsx";
import { SearchToolCard } from "./SearchToolCard.tsx";
import { GenericToolCard } from "./GenericToolCard.tsx";

export interface ToolPresentation {
  icon: LucideIcon;
  label: string;
  isBash: boolean;
}

export function getToolPresentation(toolName: string): ToolPresentation {
  const name = (toolName || "").toLowerCase();

  // 1. 终端与命令行执行
  if (
    name.includes("terminal") ||
    name.includes("bash") ||
    name.includes("exec") ||
    name.includes("command") ||
    name === "run_command"
  ) {
    return {
      icon: Terminal,
      label: "执行",
      isBash: true,
    };
  }

  // 2. 文件修改与差异
  if (
    name.includes("file") ||
    name.includes("write") ||
    name.includes("replace") ||
    name.includes("patch") ||
    name.includes("diff")
  ) {
    return {
      icon: FileCode,
      label: "编辑",
      isBash: false,
    };
  }

  // 3. 联网搜索
  if (
    name.includes("search") ||
    name.includes("web_search") ||
    name.includes("browse") ||
    name.includes("fetch_url")
  ) {
    return {
      icon: Search,
      label: "联网检索",
      isBash: false,
    };
  }

  // 4. 通用长尾工具兜底
  return {
    icon: Wrench,
    label: toolName || "tool",
    isBash: false,
  };
}

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
