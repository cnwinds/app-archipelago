export function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

export const CATEGORIES = [
  {
    id: 'game',
    name: '游戏',
    title: '游戏火山岛',
    color: '#ff7a45',
    ground: '#7d9a46',
    count: 90,
    pos: [-70, -20],
    theme: 'volcano',
    pre: ['星际', '像素', '霓虹', '深渊', '方块', '暗影', '极速', '幻境', '机甲', '龙骨', '迷宫', '浮岛', '蒸汽', '雷霆', '月球'],
    suf: ['战记', '跑酷', '塔防', '求生', '冒险', '大乱斗', '农场', '弹幕', '解谜', '竞速', '牧场', '远征'],
    tags: ['动作', '休闲', '解谜', '多人', 'Roguelike', '物理', '像素风', '3D'],
    blurb: ['打开即玩的浏览器游戏，三秒上手，一小时停不下来。', '用 WebGL 渲染的小体量大作，手感扎实。', '独立开发者周末作品，创意十足的玩法实验。', '支持手柄和触屏的多人同屏游戏。'],
  },
  {
    id: 'ai',
    name: 'AI 工具',
    title: 'AI 水晶岛',
    color: '#3fd0e0',
    ground: '#5aa58a',
    count: 80,
    pos: [55, -45],
    theme: 'crystal',
    pre: ['灵感', '智绘', '语境', '墨言', '知识', '深思', '译界', '视界', '声纹', '代码', '织梦', '洞见'],
    suf: ['助手', '画板', '工坊', '引擎', '副驾', '速记', '实验室', '魔方', '向导', '雷达'],
    tags: ['大模型', '图像生成', '写作', '翻译', '编程', '语音', 'Agent', '本地运行'],
    blurb: ['把大模型装进浏览器标签页，开箱即用。', '一句话生成你想要的结果，支持连续追问。', '面向创作者的 AI 工作流，拖拽即可编排。', '纯前端运行，数据不出本地。'],
  },
  {
    id: 'creative',
    name: '创意艺术',
    title: '创意花海岛',
    color: '#ff6f91',
    ground: '#9cc25a',
    count: 45,
    pos: [10, 62],
    theme: 'garden',
    pre: ['光影', '调色', '手绘', '流体', '粒子', '折纸', '万花', '墨韵', '霓光', '拼贴'],
    suf: ['画布', '工作室', '生成器', '实验场', '画廊', '滤镜', '织机'],
    tags: ['生成艺术', '绘画', 'Shader', '摄影', '排版', '动画'],
    blurb: ['会呼吸的画布，每一笔都在流动。', '用代码生成艺术，一键导出高清海报。', '为设计师准备的小而美的灵感工具。', '实时 Shader 玩具，拖动参数看世界变形。'],
  },
  {
    id: 'productivity',
    name: '效率工具',
    title: '效率风车岛',
    color: '#f2b544',
    ground: '#a3a65a',
    count: 50,
    pos: [98, 40],
    theme: 'windmill',
    pre: ['极简', '闪电', '番茄', '清单', '脑图', '云端', '表格', '时间', '专注', '速览'],
    suf: ['看板', '日历', '笔记', '计划', '收件箱', '仪表盘', '书签'],
    tags: ['笔记', '任务管理', '时间管理', '协作', '离线可用', '键盘流'],
    blurb: ['零学习成本的效率小工具，打开就能用。', '键盘优先的设计，比鼠标快三倍。', '本地优先，离线也能流畅工作。', '把杂乱信息整理成清晰的视图。'],
  },
  {
    id: 'music',
    name: '音乐音频',
    title: '声波岛',
    color: '#9d8cff',
    ground: '#6c8f6a',
    count: 30,
    pos: [-82, 72],
    theme: 'sound',
    pre: ['节拍', '合成', '鼓机', '和弦', '低音', '回声', '律动', '声浪', '琴键'],
    suf: ['工坊', '键盘', '混音台', '电台', '实验室', '循环器'],
    tags: ['合成器', '节拍', '可视化', '作曲', 'Web Audio'],
    blurb: ['在浏览器里搭一台合成器，现场即兴。', '把声音变成可视化的光影。', '十六步鼓机，三分钟做出一段 Loop。', '用 Web Audio 实现的专业级效果器。'],
  },
  {
    id: 'edu',
    name: '教育学习',
    title: '知识天文岛',
    color: '#6fd36f',
    ground: '#78ad5a',
    count: 35,
    pos: [-18, -98],
    theme: 'observatory',
    pre: ['几何', '星空', '化学', '单词', '编程', '历史', '物理', '地理', '数学'],
    suf: ['实验室', '闯关', '图鉴', '课堂', '模拟器', '探索'],
    tags: ['交互式', '模拟', '儿童', '编程入门', '科普'],
    blurb: ['可交互的知识模拟器，动手比看书更好懂。', '把抽象概念变成可以拖动的模型。', '闯关式学习，进度自动保存。', '面向孩子设计的科普小实验。'],
  },
];

const HANDLE = ['lumi', 'kite', 'nova', 'mochi', 'pixel', 'orbit', 'zen', 'echo', 'fern', 'atlas', 'yuki', 'leo', 'ming', 'xiao', 'rain', 'byte'];

export function generateApps() {
  const rng = mulberry32(20261113);
  const apps = [];
  for (const cat of CATEGORIES) {
    const used = new Set();
    for (let i = 0; i < cat.count; i++) {
      let name;
      let guard = 0;
      do {
        name = pick(rng, cat.pre) + pick(rng, cat.suf);
        guard++;
      } while (used.has(name) && guard < 50);
      if (used.has(name)) name += ' ' + (i + 2);
      used.add(name);

      const r = rng();
      const score = Math.round(40 + 60 * Math.pow(r, 2.2));
      const tier = score >= 90 ? 2 : score >= 70 ? 1 : 0;
      const ageDays = rng() * 60;
      const tagA = pick(rng, cat.tags);
      let tagB = pick(rng, cat.tags);
      if (tagB === tagA) tagB = null;

      apps.push({
        id: `${cat.id}-${i}`,
        name,
        cat,
        author: '@' + pick(rng, HANDLE) + Math.floor(rng() * 90 + 10),
        score,
        tier,
        ageDays,
        isNew: ageDays < 3,
        plays: Math.round(Math.pow(score / 100, 4) * 120000 * (0.4 + rng())),
        tags: tagB ? [tagA, tagB] : [tagA],
        desc: pick(rng, cat.blurb),
        position: null,
      });
    }
  }
  return apps;
}
