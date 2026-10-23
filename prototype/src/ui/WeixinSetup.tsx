import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Check, Loader2, MessageCircle, QrCode, RefreshCw, ShieldCheck } from "lucide-react";
import { beginWeixinQrLogin, pollWeixinQrLogin } from "../adapters/daemon/client.ts";
import type { ChannelAccount } from "../core/units.ts";

export function WeixinSetup({
  botId,
  account,
  onChange,
}: {
  botId: string;
  account: ChannelAccount;
  onChange: (next: ChannelAccount) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [pollStatus, setPollStatus] = useState<
    "idle" | "wait_scan" | "scanned" | "success" | "expired" | "canceled"
  >("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const hasBinding = Boolean(
    account.secretRef?.id || account.ilinkBotId || account.botTokenEnv,
  );

  const startLogin = async () => {
    setLoading(true);
    setErrorMsg(null);
    setPollStatus("wait_scan");
    try {
      const res = await beginWeixinQrLogin();
      setQrCode(res.qrCode);
      const dataUrl = await QRCode.toDataURL(res.qrUrl, {
        width: 200,
        margin: 1,
        color: { dark: "#07c160", light: "#ffffff" },
      });
      setQrDataUrl(dataUrl);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setPollStatus("idle");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!qrCode || pollStatus === "success" || pollStatus === "expired") return;

    let stopped = false;
    const interval = setInterval(async () => {
      if (stopped) return;
      try {
        const res = await pollWeixinQrLogin(qrCode, botId);
        if (res.status === "scanned") {
          setPollStatus("scanned");
        } else if (res.status === "success") {
          setPollStatus("success");
          stopped = true;
          clearInterval(interval);
          onChange({
            ...account,
            ilinkBotId: res.botId || account.ilinkBotId,
            secretRef: {
              source: "vault",
              id: `weixin:${botId}`,
            },
          });
        } else if (res.status === "expired" || res.status === "canceled") {
          setPollStatus(res.status);
          stopped = true;
          clearInterval(interval);
        }
      } catch (err) {
        console.warn("[WeixinSetup] poll failed:", err);
      }
    }, 2000);

    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, [qrCode, pollStatus, botId, account, onChange]);

  return (
    <div className="space-y-3 rounded-xl border border-line/60 bg-rail/30 p-3.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-600">
            <MessageCircle size={15} />
          </div>
          <div>
            <h4 className="text-body-sm font-medium text-ink" title="通过腾讯官方 iLink 机器人扫码配对，免封号风险">
              微信 iLink 官方协议接入
            </h4>
          </div>
        </div>

        {hasBinding && (
          <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600">
            <Check size={11} />
            <span>已绑定微信</span>
          </span>
        )}
      </div>

      {hasBinding && pollStatus === "idle" ? (
        <div className="space-y-2 rounded-lg border border-line/40 bg-card p-3 text-caption text-graphite">
          <div className="flex items-center justify-between">
            <div>
              <span className="block font-medium text-ink">
                绑定凭证：{account.secretRef?.id || "本地保险库"}
              </span>
              {account.ilinkBotId && (
                <span className="block text-[11px] text-ash font-mono">
                  Bot ID: {account.ilinkBotId}
                </span>
              )}
            </div>
            <button
              onClick={() => void startLogin()}
              className="rounded-btn border border-line bg-line-soft px-2.5 py-1 text-caption text-ink hover:border-teal hover:text-teal"
            >
              重新扫码换绑
            </button>
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-emerald-600">
            <ShieldCheck size={13} />
            <span>Token 已受本地 0600 保险库保护，不在单元配置文件留存明文。</span>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line p-4 text-center">
          {pollStatus === "wait_scan" || pollStatus === "scanned" ? (
            <div className="flex flex-col items-center space-y-2.5">
              {qrDataUrl && (
                <div className="overflow-hidden rounded-lg border border-line bg-white p-2 shadow-xs">
                  <img src={qrDataUrl} alt="微信扫码二维码" className="h-44 w-44 object-contain" />
                </div>
              )}
              <div className="flex items-center gap-1.5 text-caption font-medium">
                {pollStatus === "scanned" ? (
                  <span className="text-teal animate-pulse">
                    已扫码，请在手机微信上点击「确认登录」
                  </span>
                ) : (
                  <span className="text-graphite">请使用微信 App 扫描二维码登录</span>
                )}
              </div>
              <button
                onClick={() => void startLogin()}
                className="flex items-center gap-1 text-[11px] text-ash hover:text-teal"
              >
                <RefreshCw size={11} />
                <span>刷新二维码</span>
              </button>
            </div>
          ) : pollStatus === "success" ? (
            <div className="flex flex-col items-center space-y-1.5 text-gain py-2">
              <Check size={28} className="text-gain" />
              <span className="text-body-sm font-semibold">微信扫码绑定成功！</span>
              <span className="text-caption text-graphite">
                凭证已安全存储，现在可在微信中向该机器人发送消息与审批请求。
              </span>
            </div>
          ) : (
            <div className="flex flex-col items-center space-y-2 py-2">
              <p className="text-caption text-graphite max-w-sm">
                点击下方按钮获取微信配对二维码，管理员微信扫码后即可将此 Bot 接入微信。
              </p>
              <button
                onClick={() => void startLogin()}
                disabled={loading}
                className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-caption font-medium text-white shadow-xs transition hover:bg-emerald-700 disabled:opacity-50"
              >
                {loading ? <Loader2 size={14} className="animate-spin" /> : <QrCode size={14} />}
                <span>获取微信扫码二维码</span>
              </button>
              {errorMsg && <p className="text-[11px] text-loss">{errorMsg}</p>}
            </div>
          )}
        </div>
      )}

      {/* 微信进阶参数 */}
      <div className="space-y-2 border-t border-line/40 pt-2 text-caption">
        <label className="flex items-center gap-1.5 text-caption text-graphite">
          <input
            type="checkbox"
            checked={account.interactiveApproval !== false}
            onChange={(e) => onChange({ ...account, interactiveApproval: e.target.checked })}
          />
          <span>启用微信数字快捷审批 (回复 1 允许 / 2 拒绝 / 3 始终允许)</span>
        </label>
        <div className="space-y-1">
          <span
            className="block text-caption text-graphite"
            title="Chat ID / OpenID，必填：仅该 OpenID 的私聊会得到应答，留空则不响应任何消息"
          >
            专属对话过滤（必填）
          </span>
          <input
            value={account.chatId ?? ""}
            onChange={(e) => onChange({ ...account, chatId: e.target.value })}
            placeholder="例如: wx_user_12345"
            spellCheck={false}
            className="w-full rounded-input border border-transparent bg-rail px-2 py-1 font-mono text-caption text-ink outline-none focus:border-teal"
          />
        </div>
      </div>
    </div>
  );
}
