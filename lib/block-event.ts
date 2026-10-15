// lib/block-event.ts
// 拉黑 / 解除拉黑 在聊天历史里的提示词写法（纯格式化，不碰存储，避免循环依赖）。

import type { ChatMessage } from "./chat-storage";

type MediaData = NonNullable<ChatMessage["mediaData"]>;

/** 用户拉黑 / 解除拉黑，角色视角阅读。 */
export function formatBlockEventForPrompt(
  d: MediaData | undefined,
  userName: string,
  fallbackContent = "",
): string {
  switch (d?.blockEvent) {
    case "block":
      return `[${userName}把你拉黑了。你发的消息${userName}不会收到，也无法回复你，直到${userName}解除拉黑]`;
    case "unblock":
      return `[${userName}把你从黑名单里放出来了，你们又可以正常聊天了]`;
    default:
      return fallbackContent;
  }
}
