// lib/xiaohongshu-public-figures.ts
// 小红书路人内容流的「热点素材」：
//   · 哪些角色是公众人物：角色卡里填了「公开身份」（publicProfile）的才算
//   · 这些人今天 / 明天的日程，让路人帖子能和他们真实发生的事挂钩（直播、拍摄、红毯……）
// 路人内容流是一个独立请求，不带角色卡，所以这里只给「路人能知道的」信息：
// 公开身份 + 日程标题/地点/时间，绝不带人设、记忆、和用户的关系。

import { loadCharacters } from "./character-storage";
import { loadCalendarWeekPlan } from "./calendar-storage";
import { formatIsoDate, getWeekStartIso, getWeekdayLabel } from "./calendar-utils";

export type PublicFigureScheduleItem = {
  date: string;
  startTime: string;
  endTime: string;
  location: string;
  title: string;
};

export type PublicFigureFeedInput = {
  name: string;
  publicProfile: string;
  items: PublicFigureScheduleItem[];
};

const MAX_FIGURES = 8;
const MAX_ITEMS_PER_FIGURE = 8;

function formatItem(item: PublicFigureScheduleItem): string {
  const where = item.location ? ` @${item.location}` : "";
  return `${item.startTime}-${item.endTime}${where} ${item.title}`;
}

/** 纯格式化：便于测试。没有公众人物时返回空串（内容流保持原样）。 */
export function formatPublicFigureFeedContext(
  figures: PublicFigureFeedInput[],
  now: Date,
  tomorrowDate: string,
): string {
  const usable = figures.filter(figure => figure.name && figure.publicProfile).slice(0, MAX_FIGURES);
  if (usable.length === 0) return "";
  const today = formatIsoDate(now);
  const clock = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  const blocks = usable.map(figure => {
    const todayItems = figure.items.filter(item => item.date === today).slice(0, MAX_ITEMS_PER_FIGURE);
    const tomorrowItems = figure.items.filter(item => item.date === tomorrowDate).slice(0, MAX_ITEMS_PER_FIGURE);
    return [
      `■ ${figure.name}`,
      `[公开身份]${figure.publicProfile}`,
      `[今天日程]${todayItems.length ? todayItems.map(formatItem).join("；") : "无安排"}`,
      `[明天日程]${tomorrowItems.length ? tomorrowItems.map(formatItem).join("；") : "无安排"}`,
    ].join("\n");
  });

  return [
    "【本世界的热点素材】",
    `现在是 ${today} ${getWeekdayLabel(today)} ${clock}。下面这些人是这个世界里的公众人物，路人和粉丝会谈论他们：`,
    "",
    ...blocks,
    "",
    "使用规则：",
    "- 整个内容流里约 2~4 条笔记可以和上面的人、事挂钩，其余仍是互不相关的普通路人内容；不要每个人都出现，也不要全部写成追星。",
    "- 挂钩的方式要像真实路人和粉丝会发的：看完直播/演出的碎碎念、蹲直播打卡、追剧安利或吐槽、红毯/路透/机场图的围观、出圈片段的讨论、抢票求助、同城偶遇（只限日程里的公开场合）、粉丝的日常安利。",
    "- 只有公开活动才能被路人知道（演出、直播、拍摄、发布会、红毯、采访、签售、路演、出入公开场合等）。在家、休息、私人约会、和任何私人关系有关的安排，路人不知道，绝不能写进帖子。",
    "- 时间要对得上：日程里已经结束的，用“刚结束”“刚看完”的口吻；还没开始的，用“待会儿”“蹲一个”“预告”的口吻；明天的活动可以是预热、抢票、预告。",
    "- 路人只知道[公开身份]里写的信息，不要编造他们的私人细节、恋情、家庭背景；不确定的地方用路人的猜测、疑问、传闻口吻。不要出现“用户”本人，也不要提到任何没写在[公开身份]里的家人或亲密的人。",
    "- 如果[公开身份]里写了某人有低调的家人（例如“义妹，从不露脸”），路人只知道这一句：可以有人嗑“兄妹情深”，也可以有人觉得哪里不对劲、半真半假地猜，但都只是猜测，没有证据，不能坐实，不能编出对方的名字、长相、住址、职业等任何具体信息，也不要写成已经被抓到把柄。",
    "- 这些帖子的作者和评论者全部是路人或粉丝，昵称自创，不得使用上面这些人的名字作为作者；帖子正文里可以提到他们的名字、作品或称呼。",
    "- 粉丝态度要多样：死忠粉、理智粉、路人、挑刺的、吃瓜的、对家粉丝都可能出现，评论区不要一边倒夸。",
  ].join("\n");
}

function addDaysIso(date: Date, days: number): string {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  return formatIsoDate(next);
}

/** 读取本地的公众人物与日程，拼出内容流用的热点素材；没有公众人物时返回空串。 */
export function buildPublicFigureFeedContext(now = new Date()): string {
  try {
    const todayWeek = getWeekStartIso(now);
    const tomorrow = addDaysIso(now, 1);
    const tomorrowWeek = getWeekStartIso(new Date(`${tomorrow}T00:00:00`));
    const figures: PublicFigureFeedInput[] = loadCharacters()
      .filter(character => character.publicProfile?.trim())
      .map(character => {
        const weeks = Array.from(new Set([todayWeek, tomorrowWeek]));
        const items = weeks.flatMap(weekStart => loadCalendarWeekPlan("character", character.id, weekStart)?.items ?? []);
        return {
          name: character.name,
          publicProfile: character.publicProfile!.trim().slice(0, 400),
          items: items.map(item => ({
            date: item.date,
            startTime: item.startTime,
            endTime: item.endTime,
            location: item.location,
            title: item.title,
          })),
        };
      });
    return formatPublicFigureFeedContext(figures, now, tomorrow);
  } catch (error) {
    console.warn("[Xiaohongshu] 读取公众人物素材失败，按普通内容流生成：", error);
    return "";
  }
}
