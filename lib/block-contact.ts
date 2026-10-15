// lib/block-contact.ts
// 拉黑 / 解除拉黑角色（仅私聊）。
//   · 状态存在 ChatSession.isBlacklisted
//   · 拉黑：输入框锁定；角色的主动消息（追问 / 冷场重连 / 定时唤醒 / 经期关怀）全部停掉，
//     并撤销已预约的服务端离线推送
//   · 两个动作都往聊天里落一条 block_event 通知，角色下次生成时在历史里读到

import {
  loadChatSessions,
  pushChatMessage,
  saveChatSessions,
  type ChatSession,
} from "./chat-storage";
import { loadIdleReconnectRules } from "./idle-reconnect-storage";
import { loadTimedWakeSchedules, clearTimedWakeSchedule } from "./timed-wake-storage";
import { cancelBailoutKey, cancelBailoutPrefix } from "./push-bailout-client";
import { cancelFollowUp } from "./follow-up-service";

export const CHAT_CONTACT_BLOCK_CHANGED_EVENT = "chat-contact-block-changed";

/** 私聊且已拉黑。群聊不适用。 */
export function isSessionBlocked(session: Pick<ChatSession, "isBlacklisted" | "isGroup"> | undefined | null): boolean {
  return !!session && !session.isGroup && session.isBlacklisted === true;
}

function cancelPendingProactive(sessionId: string) {
  try {
    cancelFollowUp(sessionId);
    for (const schedule of loadTimedWakeSchedules().filter(item => item.sessionId === sessionId)) {
      cancelBailoutKey(`timedwake:${schedule.id}`);
    }
    clearTimedWakeSchedule(sessionId);
    for (const rule of loadIdleReconnectRules().filter(item => item.sessionId === sessionId)) {
      void cancelBailoutPrefix(`idle:${rule.id}:`);
    }
  } catch (error) {
    console.warn("[Block] 撤销主动消息预约失败：", error);
  }
}

function emit(sessionId: string, blocked: boolean) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CHAT_CONTACT_BLOCK_CHANGED_EVENT, { detail: { sessionId, blocked } }));
  window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId } }));
}

export function setCharacterBlocked(sessionId: string, blocked: boolean): { ok: boolean; error?: string } {
  const sessions = loadChatSessions();
  const index = sessions.findIndex(item => item.id === sessionId);
  if (index === -1) return { ok: false, error: "找不到这个聊天。" };
  const session = sessions[index];
  if (session.isGroup) return { ok: false, error: "群聊不能拉黑。" };
  if (isSessionBlocked(session) === blocked) return { ok: true };

  sessions[index] = { ...session, isBlacklisted: blocked };
  saveChatSessions(sessions);

  if (blocked) cancelPendingProactive(sessionId);

  pushChatMessage({
    sessionId,
    role: "user",
    content: blocked ? "你把TA拉黑了" : "你解除了对TA的拉黑",
    mediaType: "block_event",
    mediaData: { blockEvent: blocked ? "block" : "unblock" },
  });
  emit(sessionId, blocked);
  return { ok: true };
}
