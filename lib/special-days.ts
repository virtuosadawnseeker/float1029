/**
 * 重要日子：角色的生日、用户的生日、纪念日（认识的日子、确认关系的日子等）。
 * 数据存在 Character.specialDays 上，随角色一起备份/导入。
 * 提示词里：当天强提示（必须体现），临近 30 天内弱提示。
 */

import { kvGet, kvSet, kvRemove, registerKvMigration } from "./kv-db";

export type SpecialDayKind = "char_birthday" | "user_birthday" | "anniversary";

export type SpecialDay = {
  id: string;
  kind: SpecialDayKind;
  /** 纪念日名称，例如「认识的日子」「确认关系的日子」；生日可留空 */
  label: string;
  month: number; // 1-12
  day: number; // 1-31
  /** 可选的起始年份：生日=出生年，纪念日=发生年；填了才会算岁数/周年数 */
  year?: number;
};

export const SPECIAL_DAY_KIND_LABELS: Record<SpecialDayKind, string> = {
  char_birthday: "角色生日",
  user_birthday: "我的生日",
  anniversary: "纪念日",
};

const LOOKAHEAD_DAYS = 30;
const SOON_DAYS = 7;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function normalizeSpecialDays(value: unknown): SpecialDay[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: SpecialDay[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const src = raw as Record<string, unknown>;
    const kind = src.kind;
    if (kind !== "char_birthday" && kind !== "user_birthday" && kind !== "anniversary") continue;
    const month = Math.trunc(Number(src.month));
    const day = Math.trunc(Number(src.day));
    if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= daysInMonth(2024, month))) continue;
    const yearNum = Math.trunc(Number(src.year));
    const year = Number.isFinite(yearNum) && yearNum >= 1 && yearNum <= 9999 ? yearNum : undefined;
    out.push({
      id: typeof src.id === "string" && src.id ? src.id : `sd_${Date.now().toString(36)}_${out.length}`,
      kind,
      label: typeof src.label === "string" ? src.label.trim().slice(0, 40) : "",
      month,
      day,
      ...(year ? { year } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

type YMD = { year: number; month: number; day: number };

function getTodayInZone(now: Date, timeZone?: string): YMD {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const pick = (type: string) => Number(parts.find(p => p.type === type)?.value);
    const year = pick("year");
    const month = pick("month");
    const day = pick("day");
    if (year && month && day) return { year, month, day };
  } catch {
    // fall through to local time
  }
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

function toUtcDay(ymd: YMD): number {
  return Date.UTC(ymd.year, ymd.month - 1, ymd.day) / 86400000;
}

/** 距离下一次（含今天）该日子还有几天，以及对应年份。2/29 在平年按 2/28 算。 */
function nextOccurrence(sd: SpecialDay, today: YMD): { inDays: number; year: number } {
  const build = (year: number): YMD => ({
    year,
    month: sd.month,
    day: Math.min(sd.day, daysInMonth(year, sd.month)),
  });
  let target = build(today.year);
  let diff = toUtcDay(target) - toUtcDay(today);
  if (diff < 0) {
    target = build(today.year + 1);
    diff = toUtcDay(target) - toUtcDay(today);
  }
  return { inDays: diff, year: target.year };
}

function dayName(sd: SpecialDay, charName: string, userName: string): string {
  if (sd.kind === "char_birthday") return `${charName}的生日`;
  if (sd.kind === "user_birthday") return `${userName}的生日`;
  return `${charName}和${userName}的纪念日「${sd.label || "纪念日"}」`;
}

function yearsNote(sd: SpecialDay, occurrenceYear: number): string {
  if (!sd.year) return "";
  const n = occurrenceYear - sd.year;
  if (n <= 0) return "";
  if (sd.kind === "anniversary") return `（第 ${n} 周年）`;
  return `（${n} 岁生日）`;
}

/**
 * 三段提示词模板：当天 / 7 天内 / 30 天内。可在角色页「重要日子」里编辑，所有角色共用。
 * 占位符：{{lines}} 具体的日子列表（每行一条）、{{char}} 角色名、{{user}} 用户名。
 * 模板里没写 {{lines}} 时，日子列表会放在模板文字的前面。
 */
export type SpecialDayPromptTemplates = {
  today: string;
  soon: string;
  later: string;
};

export const DEFAULT_SPECIAL_DAY_PROMPTS: SpecialDayPromptTemplates = {
  today: [
    "【重要日子·就是今天】",
    "{{lines}}",
    "这是对 {{char}} 和 {{user}} 都很重要的日子。本次回复里必须自然地体现出你记得这一天，并按你自己的性格表达，可以是祝福、别扭、害羞、惊喜、准备礼物或约定见面，不能当成普通的一天，也不能等对方提醒才想起。若这段对话里已经提过、庆祝过，就不必每条消息重复，但整天都保持“今天是这个日子”的心境。",
  ].join("\n"),
  soon: [
    "【临近的重要日子】",
    "{{lines}}",
    "你记得这件事，可以在合适的时候自然地提起或悄悄准备，不要生硬地每次都说。",
  ].join("\n"),
  later: [
    "【之后的重要日子】",
    "{{lines}}",
    "只需心里有数，不必主动提起。",
  ].join("\n"),
};

const SPECIAL_DAY_PROMPTS_KEY = "ai_phone_special_day_prompts_v1";
registerKvMigration(SPECIAL_DAY_PROMPTS_KEY);

/** 读取用户保存的模板；没改过、或某一段被清空的，用默认值补上。 */
export function loadSpecialDayPrompts(): SpecialDayPromptTemplates {
  const merged = { ...DEFAULT_SPECIAL_DAY_PROMPTS };
  try {
    const raw = typeof window !== "undefined" ? kvGet(SPECIAL_DAY_PROMPTS_KEY) : null;
    if (!raw) return merged;
    const parsed = JSON.parse(raw) as Partial<Record<keyof SpecialDayPromptTemplates, unknown>>;
    for (const key of ["today", "soon", "later"] as const) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) merged[key] = value;
    }
  } catch {
    // 存档损坏时退回默认
  }
  return merged;
}

export function saveSpecialDayPrompts(templates: SpecialDayPromptTemplates): void {
  try { kvSet(SPECIAL_DAY_PROMPTS_KEY, JSON.stringify(templates)); } catch { /* 保存失败不影响主流程 */ }
}

export function resetSpecialDayPrompts(): void {
  try { kvRemove(SPECIAL_DAY_PROMPTS_KEY); } catch { /* 同上 */ }
}

function renderPromptTemplate(template: string, lines: string[], charName: string, userName: string): string {
  const bullets = lines.map(line => `- ${line}`).join("\n");
  const filled = template.includes("{{lines}}")
    ? template.replace(/\{\{lines\}\}/gi, bullets)
    : `${bullets}\n${template}`;
  return filled
    .replace(/\{\{char\}\}/gi, charName)
    .replace(/\{\{user\}\}/gi, userName);
}

export type SpecialDaysPromptOptions = {
  charName: string;
  userName: string;
  now?: Date;
  timeZone?: string;
  /** 单聊里用「你」指代角色；群聊里直接写角色名 */
  selfReference?: boolean;
  /** 不传就读用户保存的模板（没改过则用默认） */
  templates?: SpecialDayPromptTemplates;
};

/** 返回要拼到 timeContext 后面的文字；没有任何相关日子时返回空串。 */
export function buildSpecialDaysPrompt(days: SpecialDay[] | undefined, options: SpecialDaysPromptOptions): string {
  if (!days || days.length === 0) return "";
  const now = options.now ?? new Date();
  const today = getTodayInZone(now, options.timeZone);
  const charRef = options.selfReference ? `你（${options.charName}）` : options.charName;
  const userName = options.userName || "用户";

  const todayLines: string[] = [];
  const soonLines: string[] = [];
  const laterLines: string[] = [];

  for (const sd of days) {
    const { inDays, year } = nextOccurrence(sd, today);
    const name = dayName(sd, charRef, userName);
    const note = yearsNote(sd, year);
    const dateText = `${sd.month}月${sd.day}日`;
    if (inDays === 0) {
      todayLines.push(`今天（${dateText}）是${name}${note}`);
    } else if (inDays <= SOON_DAYS) {
      soonLines.push(`${name}${note}还有 ${inDays} 天（${dateText}）`);
    } else if (inDays <= LOOKAHEAD_DAYS) {
      laterLines.push(`${name}${note}还有 ${inDays} 天（${dateText}）`);
    }
  }

  const templates = options.templates ?? loadSpecialDayPrompts();
  const blocks: string[] = [];
  if (todayLines.length > 0) blocks.push(renderPromptTemplate(templates.today, todayLines, options.charName, userName));
  if (soonLines.length > 0) blocks.push(renderPromptTemplate(templates.soon, soonLines, options.charName, userName));
  if (laterLines.length > 0) blocks.push(renderPromptTemplate(templates.later, laterLines, options.charName, userName));
  return blocks.join("\n\n");
}
