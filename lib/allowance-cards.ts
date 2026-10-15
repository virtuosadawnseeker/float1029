// lib/allowance-cards.ts
// 亲属卡 / 亲密付 与聊天的衔接：
//   · 角色发来的卡片 [亲属卡:月额度:留言] / [亲密付:月额度:留言]（mediaType = allowance_card）
//   · 用户收下 / 婉拒 / 关闭 / 刷卡后，往该角色的聊天里落一条通知（mediaType = allowance_event），
//     让角色下一轮回复时知道发生了什么。
// 额度本身的存取（开卡、扣额度、每月清零）在 wallet-storage.ts。

import {
  loadChatSessions,
  pushChatMessage,
  updateMessageMediaData,
  type ChatMessage,
} from "./chat-storage";
import { loadCharacters } from "./character-storage";
import {
  activateAllowanceCard,
  closeAllowanceCard,
  getAllowanceCardLabel,
  getAllowanceKindLabel,
  getAllowanceRemaining,
  loadWalletState,
} from "./wallet-storage";
import type { AllowanceCard, AllowanceCardKind } from "./wallet-types";

type MediaData = NonNullable<ChatMessage["mediaData"]>;

function formatYuan(amount: number): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  return Number.isInteger(safe) ? String(safe) : safe.toFixed(2);
}

function kindOf(d: MediaData | undefined): AllowanceCardKind {
  return d?.allowanceKind === "intimate" ? "intimate" : "family";
}

// ── 给 LLM 看的历史文本 ─────────────────────────────────

/** 角色发出的卡片：和角色自己写的指令保持同一写法。 */
export function formatAllowanceCardForPrompt(d: MediaData | undefined): string {
  const kind = getAllowanceKindLabel(kindOf(d));
  const amount = formatYuan(Number(d?.amount ?? 0));
  const label = d?.label?.trim();
  return label ? `[${kind}:${amount}:${label}]` : `[${kind}:${amount}]`;
}

/** 用户对卡片做的事（角色视角阅读）。 */
export function formatAllowanceEventForPrompt(
  d: MediaData | undefined,
  userName: string,
  fallbackContent = "",
): string {
  const kind = getAllowanceKindLabel(kindOf(d));
  const amount = Number(d?.amount ?? 0);
  switch (d?.allowanceEvent) {
    case "accept":
      return `[${userName}收下了你开通的${kind}，每月额度${formatYuan(amount)}元]`;
    case "decline":
      return `[${userName}婉拒了你开通的${kind}]`;
    case "close":
      return `[${userName}关闭了你开通的${kind}]`;
    case "use": {
      const purpose = d?.allowancePurpose?.trim();
      const remaining = typeof d?.allowanceRemaining === "number" ? `，本月额度还剩${formatYuan(d.allowanceRemaining)}元` : "";
      return `[${userName}刷了你开通的${kind}，付款${amount.toFixed(2)}元${purpose ? `（${purpose}）` : ""}${remaining}]`;
    }
    default:
      return fallbackContent;
  }
}

// ── 聊天里的落库 ────────────────────────────────────────

function emitChatUpdated(sessionId: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId } }));
}

/** 找到某个角色的私聊会话（不会新建）。 */
function findSingleChatSessionId(characterId: string): string | undefined {
  return loadChatSessions().find(session => session.contactId === characterId && !session.isGroup)?.id;
}

function resolveIssuer(sessionId: string, senderName?: string): { id: string; name: string } | null {
  const session = loadChatSessions().find(item => item.id === sessionId);
  if (!session) return null;
  const character = loadCharacters().find(item => item.id === session.contactId);
  return { id: session.contactId, name: senderName?.trim() || character?.name || "TA" };
}

function pushAllowanceEvent(input: {
  sessionId: string;
  content: string;
  data: MediaData;
}): ChatMessage {
  const message = pushChatMessage({
    sessionId: input.sessionId,
    role: "user",
    content: input.content,
    mediaType: "allowance_event",
    mediaData: input.data,
  });
  emitChatUpdated(input.sessionId);
  return message;
}

/** 用户收下角色发来的卡片：在钱包里开卡，并通知角色。 */
export function acceptAllowanceCardMessage(msg: ChatMessage): { ok: boolean; error?: string; card?: AllowanceCard } {
  if (msg.mediaType !== "allowance_card") return { ok: false, error: "这不是一张卡片。" };
  const data = msg.mediaData;
  if (!data || data.status !== "pending") return { ok: false, error: "这张卡片已经处理过了。" };
  if (msg.role === "user") return { ok: false, error: "这是你发出的卡片。" };
  const issuer = resolveIssuer(msg.sessionId, data.senderName || msg.senderName);
  if (!issuer) return { ok: false, error: "找不到这位角色的聊天。" };

  const result = activateAllowanceCard({
    kind: kindOf(data),
    issuerId: issuer.id,
    issuerName: issuer.name,
    monthlyLimit: Number(data.amount ?? 0),
    note: data.label,
    sourceMessageId: msg.id,
    sessionId: msg.sessionId,
  });
  if (!result.ok || !result.card) return { ok: false, error: result.error ?? "开通失败。" };

  updateMessageMediaData(msg.id, { ...data, status: "received", allowanceCardId: result.card.id });
  const kindLabel = getAllowanceKindLabel(kindOf(data));
  pushAllowanceEvent({
    sessionId: msg.sessionId,
    content: `你收下了${issuer.name}的${kindLabel}`,
    data: {
      allowanceEvent: "accept",
      allowanceKind: kindOf(data),
      allowanceCardId: result.card.id,
      amount: result.card.monthlyLimit,
    },
  });
  return { ok: true, card: result.card };
}

/** 用户婉拒角色发来的卡片。 */
export function declineAllowanceCardMessage(msg: ChatMessage): { ok: boolean; error?: string } {
  if (msg.mediaType !== "allowance_card") return { ok: false, error: "这不是一张卡片。" };
  const data = msg.mediaData;
  if (!data || data.status !== "pending") return { ok: false, error: "这张卡片已经处理过了。" };
  const issuer = resolveIssuer(msg.sessionId, data.senderName || msg.senderName);
  updateMessageMediaData(msg.id, { ...data, status: "declined" });
  pushAllowanceEvent({
    sessionId: msg.sessionId,
    content: `你婉拒了${issuer?.name ?? "TA"}的${getAllowanceKindLabel(kindOf(data))}`,
    data: {
      allowanceEvent: "decline",
      allowanceKind: kindOf(data),
      amount: Number(data.amount ?? 0),
    },
  });
  return { ok: true };
}

/** 在钱包里关闭一张卡，并通知角色。 */
export function closeAllowanceCardAndNotify(cardId: string): { ok: boolean; error?: string } {
  const result = closeAllowanceCard(cardId);
  if (!result.ok || !result.card) return { ok: false, error: result.error ?? "关闭失败。" };
  const card = result.card;
  const sessionId = card.sessionId && loadChatSessions().some(s => s.id === card.sessionId)
    ? card.sessionId
    : findSingleChatSessionId(card.issuerId);
  if (sessionId) {
    pushAllowanceEvent({
      sessionId,
      content: `你关闭了${getAllowanceCardLabel(card)}`,
      data: {
        allowanceEvent: "close",
        allowanceKind: card.kind,
        allowanceCardId: card.id,
        amount: card.monthlyLimit,
      },
    });
  }
  return { ok: true };
}

/** 用户刷了额度卡之后，往开卡角色的私聊里落一条通知（角色下一次回复时就知道了）。 */
export function notifyAllowanceUsed(input: { cardId: string; amount: number; purpose?: string }): void {
  const card = (loadWalletState().allowanceCards ?? []).find(item => item.id === input.cardId);
  if (!card) return;
  const sessionId = card.sessionId && loadChatSessions().some(s => s.id === card.sessionId)
    ? card.sessionId
    : findSingleChatSessionId(card.issuerId);
  if (!sessionId) return;
  const purpose = input.purpose?.trim().slice(0, 80);
  pushAllowanceEvent({
    sessionId,
    content: `你用${getAllowanceCardLabel(card)}付了 ¥${input.amount.toFixed(2)}${purpose ? `（${purpose}）` : ""}`,
    data: {
      allowanceEvent: "use",
      allowanceKind: card.kind,
      allowanceCardId: card.id,
      amount: input.amount,
      allowancePurpose: purpose || undefined,
      allowanceRemaining: getAllowanceRemaining(card),
    },
  });
}
