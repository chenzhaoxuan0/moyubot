import { useEffect, useState, useId } from "react";
import QRCode from "qrcode";
import {
  AlertCircle,
  Check,
  Cloud,
  Copy,
  ExternalLink,
  Globe,
  HelpCircle,
  MessageCircle,
  Play,
  QrCode,
  Radio,
  RefreshCw,
  Send,
  ShieldCheck,
  Smartphone,
  Square,
  Terminal,
  X,
} from "lucide-react";
import {
  fetchNetworkInterfaces,
  getChannelStatusRpc,
  fetchTunnelState,
  startTunnel,
  stopTunnel,
  type ChannelStatusResult,
  type NetworkInterfaceInfo,
  type TunnelState,
} from "../adapters/daemon/client.ts";
import { useWorkbench, selectActiveUnit } from "../store/useWorkbench.ts";
import { useShell } from "../store/useShell.ts";
import { cn } from "./cn.ts";
import { useSidePane } from "../store/useSidePane.ts";

export function RemoteControlDialog({ onClose, embedded = false }: { onClose: () => void; embedded?: boolean }) {
  const dialogTitleId = useId();
  const [tab, setTab] = useState<"lan" | "tunnel" | "im">("lan");
  const [interfaces, setInterfaces] = useState<readonly NetworkInterfaceInfo[]>([]);
  const [selectedIp, setSelectedIp] = useState<string>("");
  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [channelStatus, setChannelStatus] = useState<ChannelStatusResult | null>(null);

  // 公网穿透状态
  const [tunnelState, setTunnelState] = useState<TunnelState | null>(null);
  const [tunnelLoading, setTunnelLoading] = useState(false);
  const [customTunnelUrl, setCustomTunnelUrl] = useState("");
  const [tunnelQrDataUrl, setTunnelQrDataUrl] = useState("");
  const [tunnelCopied, setTunnelCopied] = useState(false);
  const [wingetCopied, setWingetCopied] = useState(false);

  const activeUnit = useWorkbench(selectActiveUnit);

  // 1. 加载网卡、渠道状态与公网穿透
  const refreshData = async () => {
    setLoading(true);
    try {
      const [nets, chan, tun] = await Promise.all([
        fetchNetworkInterfaces(),
        getChannelStatusRpc().catch(() => null),
        fetchTunnelState().catch(() => null),
      ]);
      setInterfaces(nets);
      if (chan) setChannelStatus(chan);
      if (tun) {
        setTunnelState(tun);
        if (tun.customUrl) setCustomTunnelUrl(tun.customUrl);
      }

      // 默认选中推荐网卡（LAN 或 Tailscale，优先级最高排最前）
      const best = nets.find((n) => n.family === "IPv4" && n.type !== "loopback") || nets[0];
      if (best) setSelectedIp(best.address);
    } catch (err) {
      console.warn("[RemoteControlDialog] refresh failed:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshData();
  }, []);

  // 2. 构造移动端直连 URL 并生成二维码
  const token =
    typeof window !== "undefined"
      ? localStorage.getItem("agent-workbench:daemon-token") || ""
      : "";
  const port =
    typeof window !== "undefined" && window.location.port
      ? window.location.port
      : "3000";

  const unitParam = activeUnit?.id ? `&unit=${encodeURIComponent(activeUnit.id)}` : "";

  const mobileUrl = selectedIp
    ? `http://${selectedIp}:${port}${token ? `?token=${encodeURIComponent(token)}` : ""}${unitParam}`
    : "";

  useEffect(() => {
    if (!mobileUrl) return;
    QRCode.toDataURL(mobileUrl, {
      width: 256,
      margin: 2,
      color: {
        dark: "#141517",
        light: "#ffffff",
      },
    })
      .then((url) => setQrDataUrl(url))
      .catch((err) => console.error("QR Code error:", err));
  }, [mobileUrl]);

  // 公网穿透直连 URL 并生成二维码
  const tunnelMobileUrl = tunnelState?.url
    ? `${tunnelState.url}${token ? `?token=${encodeURIComponent(token)}` : ""}${unitParam}`
    : "";

  useEffect(() => {
    if (!tunnelMobileUrl) {
      setTunnelQrDataUrl("");
      return;
    }
    QRCode.toDataURL(tunnelMobileUrl, {
      width: 256,
      margin: 2,
      color: {
        dark: "#141517",
        light: "#ffffff",
      },
    })
      .then((url) => setTunnelQrDataUrl(url))
      .catch((err) => console.error("Tunnel QR Code error:", err));
  }, [tunnelMobileUrl]);

  const handleCopy = () => {
    if (!mobileUrl) return;
    void navigator.clipboard.writeText(mobileUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleTunnelCopy = () => {
    if (!tunnelMobileUrl) return;
    void navigator.clipboard.writeText(tunnelMobileUrl);
    setTunnelCopied(true);
    setTimeout(() => setTunnelCopied(false), 2000);
  };

  const handleWingetCopy = () => {
    void navigator.clipboard.writeText("winget install Cloudflare.cloudflared");
    setWingetCopied(true);
    setTimeout(() => setWingetCopied(false), 2000);
  };

  // 穿透操作
  const handleStartCloudflared = async () => {
    setTunnelLoading(true);
    try {
      const state = await startTunnel({ provider: "cloudflared" });
      setTunnelState(state);
      if (state.status === "starting") {
        let attempts = 0;
        const interval = setInterval(async () => {
          attempts++;
          try {
            const current = await fetchTunnelState();
            setTunnelState(current);
            if (current.status !== "starting" || attempts > 10) {
              clearInterval(interval);
              setTunnelLoading(false);
            }
          } catch {
            clearInterval(interval);
            setTunnelLoading(false);
          }
        }, 1500);
      } else {
        setTunnelLoading(false);
      }
    } catch (err) {
      console.error("Start tunnel failed:", err);
      setTunnelLoading(false);
    }
  };

  const handleStartCustom = async () => {
    if (!customTunnelUrl.trim()) return;
    setTunnelLoading(true);
    try {
      const state = await startTunnel({
        provider: "custom",
        customUrl: customTunnelUrl.trim(),
      });
      setTunnelState(state);
    } catch (err) {
      console.error("Start custom tunnel failed:", err);
    } finally {
      setTunnelLoading(false);
    }
  };

  const handleStopTunnel = async () => {
    setTunnelLoading(true);
    try {
      const state = await stopTunnel();
      setTunnelState(state);
    } catch (err) {
      console.error("Stop tunnel failed:", err);
    } finally {
      setTunnelLoading(false);
    }
  };

  return (
    <div
      className={
        embedded
          ? // 内嵌形态（设置页 remoteControl 分区）：去掉全屏遮罩与圆角浮层壳，
            // 直接填充分区内容列；标题栏的关闭钮由分区自己渲染，这里不画
            "relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink"
          : "fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs animate-in fade-in duration-200"
      }
      role={embedded ? undefined : "dialog"}
      aria-modal={embedded ? undefined : true}
      aria-labelledby={dialogTitleId}
    >
      <div
        className={cn(
          embedded
            ? "flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-ink"
            : "relative flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line/80 bg-canvas text-ink shadow-2xl",
        )}
      >
        {/* 顶部标题栏 */}
        <div className="flex items-center justify-between border-b border-line/60 bg-rail/60 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal/15 text-teal shadow-xs">
              <Smartphone size={20} />
            </div>
            <div>
              <h2
                id={dialogTitleId}
                className="text-body font-semibold tracking-tight text-ink"
                title="三轨互联：局域网 Web 触控 + 公网穿透直连 + 离场 IM 渠道实时互动"
              >
                移动端远控中心
              </h2>
            </div>
          </div>
          {!embedded && (
            <button
              onClick={onClose}
              aria-label="关闭弹窗"
              className="rounded-btn p-1.5 text-graphite transition hover:bg-line-soft hover:text-ink"
            >
              <X size={18} />
            </button>
          )}
        </div>

        {/* 选项卡切换 */}
        <div className="flex border-b border-line/60 bg-card/40 px-6">
          <button
            onClick={() => setTab("lan")}
            className={cn(
              "flex items-center gap-2 border-b-2 px-4 py-3 text-body-sm font-medium transition",
              tab === "lan"
                ? "border-teal text-teal"
                : "border-transparent text-graphite hover:text-ink",
            )}
          >
            <QrCode size={16} />
            <span>近场扫码 (局域网 Web)</span>
          </button>
          <button
            onClick={() => setTab("tunnel")}
            className={cn(
              "flex items-center gap-2 border-b-2 px-4 py-3 text-body-sm font-medium transition",
              tab === "tunnel"
                ? "border-teal text-teal"
                : "border-transparent text-graphite hover:text-ink",
            )}
          >
            <Globe size={16} />
            <span>公网穿透直连 (Cloudflare / Frp)</span>
            {tunnelState?.status === "running" && (
              <span className="h-2 w-2 rounded-full bg-gain animate-pulse" />
            )}
          </button>
          <button
            onClick={() => setTab("im")}
            className={cn(
              "flex items-center gap-2 border-b-2 px-4 py-3 text-body-sm font-medium transition",
              tab === "im"
                ? "border-teal text-teal"
                : "border-transparent text-graphite hover:text-ink",
            )}
          >
            <Radio size={16} />
            <span>离场 IM 渠道 (微信/飞书/TG/Discord)</span>
          </button>
        </div>

        {/* 内容区 */}
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {tab === "lan" ? (
            <div className="space-y-6">
              {/* 网卡选择器 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label htmlFor="network-select" className="text-body-sm font-medium text-ink">
                    选择本机网络接口
                  </label>
                  <button
                    onClick={() => void refreshData()}
                    className="flex items-center gap-1 text-caption text-ash hover:text-teal"
                  >
                    <RefreshCw size={12} className={cn(loading && "animate-spin")} />
                    <span>刷新接口</span>
                  </button>
                </div>
                <select
                  id="network-select"
                  aria-label="选择本机网络接口"
                  value={selectedIp}
                  onChange={(e) => setSelectedIp(e.target.value)}
                  title="确保手机与电脑连入同一 Wi-Fi，或使用 Tailscale 跨网访问。"
                  className="w-full rounded-lg border border-line bg-rail px-3 py-2 text-body-sm text-ink outline-none transition focus:border-teal"
                >
                  {interfaces.map((iface) => (
                    <option key={`${iface.name}-${iface.address}`} value={iface.address}>
                      {iface.address} ({iface.name} ·{" "}
                      {iface.type === "lan"
                        ? "局域网推荐"
                        : iface.type === "tailscale"
                          ? "Tailscale/VPN"
                          : iface.type === "loopback"
                            ? "本机回环"
                            : iface.type}
                      )
                    </option>
                  ))}
                </select>
              </div>

              {/* 二维码与链接展示 */}
              <div className="grid grid-cols-1 items-center gap-6 rounded-2xl border border-line/70 bg-rail/30 p-5 md:grid-cols-2">
                {/* 二维码 */}
                <div className="flex flex-col items-center justify-center gap-2">
                  <div className="relative flex aspect-square w-48 items-center justify-center overflow-hidden rounded-xl border border-line/80 bg-white p-3 shadow-md">
                    {qrDataUrl ? (
                      <img
                        src={qrDataUrl}
                        alt="手机扫码直连二维码"
                        className="h-full w-full object-contain"
                      />
                    ) : (
                      <div className="flex flex-col items-center gap-2 text-ash">
                        <RefreshCw size={24} className="animate-spin" />
                        <span className="text-caption">生成二维码中...</span>
                      </div>
                    )}
                  </div>
                  <span className="text-[12px] font-medium text-graphite">
                    手机相机或浏览器直接扫码
                  </span>
                </div>

                {/* 链接与一键复制 */}
                <div className="flex flex-col justify-center space-y-3">
                  <div>
                    <span className="block text-caption font-medium text-graphite">直连地址</span>
                    <div className="mt-1 flex items-center gap-2">
                      <input
                        readOnly
                        aria-label="直连地址"
                        value={mobileUrl}
                        className="w-full truncate rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-[12px] text-ink select-all focus:outline-none"
                      />
                      <button
                        onClick={handleCopy}
                        aria-label="复制直连地址"
                        className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line/80 bg-line-soft px-3 py-2 text-caption font-medium text-ink transition hover:bg-teal hover:text-white"
                      >
                        {copied ? <Check size={14} /> : <Copy size={14} />}
                        <span>{copied ? "已复制" : "复制"}</span>
                      </button>
                    </div>
                  </div>

                  <div className="space-y-1.5 rounded-xl bg-teal-tint/50 p-3 text-caption text-graphite border border-teal/20">
                    <div className="flex items-center gap-1.5 font-medium text-teal">
                      <ShieldCheck size={14} />
                      <span>无缝免输密钥配对</span>
                    </div>
                    <p className="text-[11px] leading-relaxed">
                      二维码中已内嵌临时配对令牌，手机扫码后自动静默鉴权并持久化存储，无需反复输入。
                    </p>
                  </div>
                </div>
              </div>

              {/* 移动端专属革新特性 */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="flex items-start gap-2.5 rounded-xl border border-line/60 bg-rail/40 p-3">
                  <Smartphone size={16} className="mt-0.5 shrink-0 text-teal" />
                  <h3 className="text-caption font-semibold text-ink" title="基于 100dvh 与弹性底抽屉，打字不遮挡消息流">
                    抗软键盘畸变
                  </h3>
                </div>

                <div className="flex items-start gap-2.5 rounded-xl border border-line/60 bg-rail/40 p-3">
                  <ShieldCheck size={16} className="mt-0.5 shrink-0 text-teal" />
                  <h3 className="text-caption font-semibold text-ink" title="工具调用拦截门底部卡片呈现，支持大触控按钮快捷决策">
                    手势触控审批
                  </h3>
                </div>

                <div className="flex items-start gap-2.5 rounded-xl border border-line/60 bg-rail/40 p-3">
                  <Terminal size={16} className="mt-0.5 shrink-0 text-teal" />
                  <h3 className="text-caption font-semibold text-ink" title="辅助终端包含 Esc / Tab / Ctrl-C 等快捷按键行">
                    虚拟按键终端
                  </h3>
                </div>
              </div>
            </div>
          ) : tab === "tunnel" ? (
            /* 公网穿透直连选项卡 */
            <div className="space-y-6">
              {/* 顶部状态提示 */}
              <div className="flex items-center justify-between rounded-xl border border-line/60 bg-rail/40 p-4">
                <div>
                  <h3
                    className="text-body-sm font-semibold text-ink"
                    title="无需路由器端口映射，通过 Cloudflare Quick Tunnel 或自定义反代域名，手机在任何蜂窝网络下均可扫码秒连。"
                  >
                    脱离局域网 · 全球公网访问
                  </h3>
                </div>
                <button
                  onClick={() => void refreshData()}
                  className="flex items-center gap-1 text-caption text-ash hover:text-teal"
                >
                  <RefreshCw size={12} className={cn(loading && "animate-spin")} />
                  <span>刷新状态</span>
                </button>
              </div>

              {/* 错误提示 */}
              {tunnelState?.error && (
                <div className="flex items-center gap-2.5 rounded-xl border border-loss/20 bg-loss/10 p-3.5 text-caption text-loss">
                  <AlertCircle size={16} className="shrink-0" />
                  <span>{tunnelState.error}</span>
                </div>
              )}

              {/* 运行中的公网二维码与链接 */}
              {tunnelState?.status === "running" && tunnelMobileUrl ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between rounded-xl border border-gain/30 bg-gain-tint/40 px-4 py-2.5 text-body-sm font-medium text-gain">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-gain animate-pulse" />
                      <span>公网隧道已建立 ({tunnelState.provider === "cloudflared" ? "Cloudflare Quick Tunnel" : "自定义域名"})</span>
                    </div>
                    <button
                      onClick={handleStopTunnel}
                      disabled={tunnelLoading}
                      className="flex items-center gap-1.5 rounded-lg border border-line bg-canvas px-3 py-1 text-caption text-ink hover:bg-loss-tint hover:text-loss transition"
                    >
                      <Square size={12} />
                      <span>停止穿透</span>
                    </button>
                  </div>

                  <div className="grid grid-cols-1 items-center gap-6 rounded-2xl border border-line/70 bg-rail/30 p-5 md:grid-cols-2">
                    {/* 二维码 */}
                    <div className="flex flex-col items-center justify-center gap-2">
                      <div className="relative flex aspect-square w-48 items-center justify-center overflow-hidden rounded-xl border border-line/80 bg-white p-3 shadow-md">
                        {tunnelQrDataUrl ? (
                          <img
                            src={tunnelQrDataUrl}
                            alt="公网直连二维码"
                            className="h-full w-full object-contain"
                          />
                        ) : (
                          <div className="flex flex-col items-center gap-2 text-ash">
                            <RefreshCw size={24} className="animate-spin" />
                            <span className="text-caption">生成二维码中...</span>
                          </div>
                        )}
                      </div>
                      <span className="text-[12px] font-medium text-graphite">
                        手机在任何外网/蜂窝网络下扫码秒连
                      </span>
                    </div>

                    {/* 链接与复制 */}
                    <div className="flex flex-col justify-center space-y-3">
                      <div>
                        <span className="block text-caption font-medium text-graphite">公网直连地址</span>
                        <div className="mt-1 flex items-center gap-2">
                          <input
                            readOnly
                            aria-label="公网直连地址"
                            value={tunnelMobileUrl}
                            className="w-full truncate rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-[12px] text-ink select-all focus:outline-none"
                          />
                          <button
                            onClick={handleTunnelCopy}
                            aria-label="复制公网地址"
                            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line/80 bg-line-soft px-3 py-2 text-caption font-medium text-ink transition hover:bg-teal hover:text-white"
                          >
                            {tunnelCopied ? <Check size={14} /> : <Copy size={14} />}
                            <span>{tunnelCopied ? "已复制" : "复制"}</span>
                          </button>
                        </div>
                      </div>

                      <div className="rounded-xl bg-teal-tint/50 p-3 text-caption text-graphite border border-teal/20">
                        <div
                          className="flex items-center gap-1.5 font-medium text-teal"
                          title="二维码包含加密访问令牌，外网访问受到与桌面端同级的鉴权保护与首响仲裁约束。"
                        >
                          <ShieldCheck size={14} />
                          <span>端到端令牌鉴权保护</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ) : tunnelState?.status === "starting" ? (
                /* 启动中状态 */
                <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-line/80 bg-rail/40 py-12 text-center">
                  <RefreshCw size={32} className="animate-spin text-teal" />
                  <div className="space-y-1">
                    <h4 className="text-body-sm font-semibold text-ink">正在建立公网隧道...</h4>
                    <p className="text-caption text-ash">
                      向 Cloudflare 申请临时加密公网域名，通常耗时 3~8 秒，请稍候。
                    </p>
                  </div>
                </div>
              ) : (
                /* 双模穿透配置卡片 */
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  {/* Cloudflare Quick Tunnel */}
                  <div className="flex flex-col justify-between rounded-xl border border-line/70 bg-card p-4 space-y-4">
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal/15 text-teal">
                          <Cloud size={18} />
                        </div>
                        <div>
                          <h4
                            className="text-body-sm font-semibold text-ink"
                            title="由 Cloudflare 官方提供临时加密隧道服务，自动生成 trycloudflare.com 域名，免配公网 IP 与路由器。"
                          >
                            Cloudflare Quick Tunnel
                          </h4>
                          <span className="text-[11px] text-teal font-medium">推荐 · 零配置即开即用</span>
                        </div>
                      </div>
                    </div>

                    {tunnelState?.cloudflaredAvailable ? (
                      <button
                        onClick={handleStartCloudflared}
                        disabled={tunnelLoading}
                        className="flex w-full items-center justify-center gap-2 rounded-xl bg-teal px-4 py-2.5 text-body-sm font-semibold text-white shadow-xs transition hover:bg-teal-hover active:scale-[0.98] disabled:opacity-50"
                      >
                        {tunnelLoading ? (
                          <RefreshCw size={16} className="animate-spin" />
                        ) : (
                          <Play size={16} />
                        )}
                        <span>一键启动公网穿透</span>
                      </button>
                    ) : (
                      <div className="space-y-2 rounded-lg border border-line bg-rail/60 p-3 text-[11px]">
                        <span className="font-medium text-amber-600 block">未检测到 cloudflared 工具</span>
                        <p className="text-ash">可复制以下命令在终端中快速安装：</p>
                        <div className="flex items-center gap-1.5">
                          <code className="flex-1 truncate rounded bg-canvas px-2 py-1 font-mono text-[10px] text-ink border border-line">
                            winget install Cloudflare.cloudflared
                          </code>
                          <button
                            onClick={handleWingetCopy}
                            className="shrink-0 rounded border border-line px-2 py-1 text-[10px] font-medium hover:bg-line-soft transition"
                          >
                            {wingetCopied ? <Check size={12} className="text-gain" /> : <Copy size={12} />}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* 自定义反代 / Frp / Ngrok */}
                  <div className="flex flex-col justify-between rounded-xl border border-line/70 bg-card p-4 space-y-4">
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-line-soft text-graphite">
                          <Globe size={18} />
                        </div>
                        <div>
                          <h4
                            className="text-body-sm font-semibold text-ink"
                            title="如果您已配置 Frp / Ngrok / Cloudflare Tunnel 固定域名反代本机 daemon 端口，可直接在此填入。"
                          >
                            自定义域名 / Frp / Ngrok
                          </h4>
                          <span className="text-[11px] text-ash">自建穿透 · 永久固定域名</span>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <input
                        type="url"
                        placeholder="https://agent.yourdomain.com"
                        value={customTunnelUrl}
                        onChange={(e) => setCustomTunnelUrl(e.target.value)}
                        className="w-full rounded-lg border border-line bg-rail px-3 py-2 text-body-sm text-ink outline-none transition focus:border-teal"
                      />
                      <button
                        onClick={handleStartCustom}
                        disabled={tunnelLoading || !customTunnelUrl.trim()}
                        className="flex w-full items-center justify-center gap-2 rounded-xl border border-line bg-card px-4 py-2.5 text-body-sm font-semibold text-ink transition hover:bg-line-soft active:scale-[0.98] disabled:opacity-50"
                      >
                        <Check size={16} className="text-teal" />
                        <span>启用自定义公网地址</span>
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* IM 渠道状态选项卡 */
            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <div>
                  <h3
                    className="text-body-sm font-semibold text-ink"
                    title="即使离开电脑或不在局域网，四大 IM 机器人也可接收指令并实时推送审批按钮。"
                  >
                    离场 IM 渠道守护状态
                  </h3>
                </div>
                {activeUnit && (
                  <button
                    onClick={() => {
                      onClose();
                      // 设置面归拢（2026-10-23）：渠道配置在右栏 bot 设置面板的「渠道」区
                      useSidePane.getState().openContext({ unitId: activeUnit.id, unitName: activeUnit.name });
                    }}
                    className="flex items-center gap-1.5 rounded-lg bg-teal px-3 py-1.5 text-caption font-medium text-white shadow-xs transition hover:bg-teal-hover"
                  >
                    <span>配置渠道</span>
                    <ExternalLink size={12} />
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                {/* 微信 */}
                <ChannelCard
                  name="微信 (WeChat)"
                  desc="官方 iLink Bot 协议 · 微信扫码即连 · 极速安全免封号"
                  icon={MessageCircle}
                  status={channelStatus?.gateways["weixin"]}
                  interactive={true}
                />

                {/* 飞书 */}
                <ChannelCard
                  name="飞书 (Feishu)"
                  desc="官方 WebSocket 长连接 · 自动回复 · 表情状态透传"
                  icon={Send}
                  status={channelStatus?.gateways["feishu"]}
                  interactive={true}
                />

                {/* Telegram */}
                <ChannelCard
                  name="Telegram"
                  desc="长轮询 · 内联键盘按钮实时审批 · 指令直控"
                  icon={Globe}
                  status={channelStatus?.gateways["telegram"]}
                  interactive={true}
                />

                {/* Discord */}
                <ChannelCard
                  name="Discord"
                  desc="Gateway v10 · 组件交互按钮实时审批 · 频道/群聊响应"
                  icon={Radio}
                  status={channelStatus?.gateways["discord"]}
                  interactive={true}
                />
              </div>

              <div className="rounded-xl border border-line/60 bg-rail/40 p-4 text-caption leading-relaxed text-graphite">
                <div
                  className="flex items-center gap-1.5 font-medium text-ink"
                  title="当 bot 遇到危险操作触发确认门时，局域网手机 Web、桌面端与所有已配置的 IM 渠道将同步收到审批请求。任何一端点击批准或拒绝后，系统立即实行首响仲裁，其余所有设备与 Bot 消息中的按钮将毫秒级自动置灰，绝无重复执行风险。"
                >
                  <HelpCircle size={14} className="text-teal" />
                  <span>首响仲裁与多端协同机制</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ChannelCard({
  name,
  desc,
  icon: Icon,
  status,
  interactive,
}: {
  name: string;
  desc: string;
  icon: typeof MessageCircle;
  status?: number | { running?: boolean; accounts?: number; details?: Record<string, unknown> };
  interactive?: boolean;
}) {
  const accountsCount =
    typeof status === "number"
      ? status
      : typeof status?.accounts === "number"
        ? status.accounts
        : 0;
  const isRunning =
    typeof status === "number"
      ? status > 0
      : status?.running === true || accountsCount > 0;

  return (
    <div className="flex flex-col justify-between rounded-xl border border-line/70 bg-card p-4 transition hover:border-line-strong">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-line-soft text-teal">
              <Icon size={16} />
            </div>
            <h4 className="text-body-sm font-semibold text-ink" title={desc}>
              {name}
            </h4>
          </div>
          <span
            className={cn(
              "flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium",
              isRunning
                ? "bg-gain-tint text-gain"
                : accountsCount > 0
                  ? "bg-amber-500/10 text-amber-600"
                  : "bg-line-soft text-ash",
            )}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                isRunning ? "bg-gain animate-pulse" : accountsCount > 0 ? "bg-amber-500" : "bg-ash",
              )}
            />
            {isRunning ? "在线守护中" : accountsCount > 0 ? "已配置 (未连接)" : "未配置"}
          </span>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-line/40 pt-2 text-[11px] text-ash">
        <span>配置账号数：{accountsCount}</span>
        {interactive && <span className="text-teal font-medium">支持按钮交互审批</span>}
      </div>
    </div>
  );
}
