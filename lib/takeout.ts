import type { ChatMessage } from "./chat-storage";
import { makeTimedWakeId, saveTimedWakeSchedule, type TimedWakeSchedule } from "./timed-wake-storage";

/** 外卖送达前的等待时间(分钟):到点后角色会再回应一次 */
export const TAKEOUT_ETA_MINUTES = 30;

export type TakeoutQuickPick = { shop: string; items: string; price: number; icon: string };

export const TAKEOUT_QUICK_PICKS: TakeoutQuickPick[] = [
    { shop: "奶茶店", items: "杨枝甘露(少糖)", price: 19, icon: "🧋" },
    { shop: "咖啡店", items: "拿铁", price: 22, icon: "☕" },
    { shop: "炸鸡店", items: "炸鸡桶套餐", price: 49, icon: "🍗" },
    { shop: "面馆", items: "红烧牛肉面", price: 28, icon: "🍜" },
    { shop: "烧烤店", items: "烤串夜宵拼盘", price: 68, icon: "🍢" },
    { shop: "甜品店", items: "草莓蛋糕", price: 32, icon: "🍰" },
    { shop: "药店", items: "感冒灵+热水袋", price: 36, icon: "💊" },
];

type TakeoutData = NonNullable<ChatMessage["mediaData"]>;

/** 给 LLM 看的历史文本(用户视角发起,角色视角阅读) */
export function formatTakeoutForPrompt(d: TakeoutData | undefined, userName: string): string {
    const shop = d?.takeoutShop?.trim();
    const items = d?.takeoutItems?.trim() || d?.label?.trim() || "外卖";
    const parts = [`${userName}给你点了外卖：${shop ? `${shop}的` : ""}${items}`];
    if (typeof d?.amount === "number" && d.amount > 0) parts.push(`实付${d.amount.toFixed(2)}元`);
    if (d?.takeoutNote?.trim()) parts.push(`留言：${d.takeoutNote.trim()}`);
    parts.push(`约${d?.takeoutEtaMinutes ?? TAKEOUT_ETA_MINUTES}分钟后送到你手上`);
    return `[${parts.join("，")}]`;
}

/** 预约「外卖送达」后角色主动回应(复用定时主动消息) */
export function scheduleTakeoutArrivalWake(input: {
    sessionId: string;
    characterId: string;
    userName: string;
    data: TakeoutData;
}): TimedWakeSchedule {
    const now = Date.now();
    const minutes = input.data.takeoutEtaMinutes ?? TAKEOUT_ETA_MINUTES;
    const items = input.data.takeoutItems?.trim() || "外卖";
    const schedule: TimedWakeSchedule = {
        id: makeTimedWakeId(input.sessionId),
        sessionId: input.sessionId,
        characterId: input.characterId,
        createdAt: now,
        fireAt: now + minutes * 60_000,
        delayMinutes: minutes,
        intent: `${input.userName}之前给你点的外卖「${items}」到了。你已经收到了外卖，主动跟${input.userName}说一声：拿到了/尝了/吃了的感受和反应，按你的性格自然表达`,
    };
    saveTimedWakeSchedule(schedule);
    void import("./push-bailout-client").then(m => m.armTimedWakeBailout(schedule)).catch(() => undefined);
    return schedule;
}
