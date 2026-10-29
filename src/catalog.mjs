export const CATALOG = [
 ['黄金','JZJ_au',true],['白银','JZJ_ag',true],['铂金','JZJ_pt',true],['钯金','JZJ_pd',true],['铑金','RH_JZL',true],
 ['黄金TD','Au(T+D)'],['黄金9999','Au99.99'],['黄金9995','Au99.95'],['白银TD','Ag(T+D)'],['铂金9995','Pt99.95'],
 ['美黄金','GLNC'],['美白银','SLNC'],['美铂金','PLNC'],['美钯金','PANC'],['伦敦金','XAU'],['伦敦银','XAG'],['伦敦铂','XAP'],['伦敦钯','XPD'],['美元兑离岸','USDCNH'],
 ['港金',null],['美元指数',null],['公斤条',null],['公斤铂',null],['公斤钯',null],['公斤银',null],['沪金主力',null],['沪金次主力',null],['沪银主力',null],['沪银次主力',null],['美铑金',null],
].map(([name,code,split=false])=>({name,code,split}));
export const FIELD_LABELS={buy:'回购价',sell:'销售价',high:'最高价',low:'最低价'};

// start:aigc.
// 三元目录 seed：数据源（SOURCES）、基础行情（BASE_QUOTES）、业务品类（CATEGORIES）。
// 首次启动时由 store 迁移进 SQLite；运行期目录从 SQLite 读取，改品类无需改代码。
// 基础行情仅登记「有实时数据源」的品种；硬缺口品种（公斤条/公斤铂/公斤钯/公斤银/
// 沪金次主力/沪银次主力/美铑金）不在 seed 内，后续由用户按公式自行配置。
// end:aigc.
// start:aigc. 2026-10-29 P2 复审：iTick 映射的过期阈值。轮询 45 秒 + 13 秒逐请求间隔，
// 同一 code 的更新周期即 45 秒；若沿用全局 45 秒阈值，任何一次网络抖动都会把报价判成
// 停更（零余量），且旧恢复机制还要再等 3 轮。放宽到 150 秒 = 约 3 个周期余量，
// 既容忍偶发单轮失手，又不至于把真正断流掩盖太久
export const ITICK_STALE_MS = 150000;
// end:aigc.
export const SOURCES = [
  { id: 'rtj', name: '融通金', type: 'websocket', enabled: true },
  { id: 'wscn', name: '华尔街见闻', type: 'http', enabled: true },
  { id: 'itick', name: 'iTick', type: 'http', enabled: true },
  // start:aigc. 2026-10-29 第四批退役（§9/§17.2）：sina（机房 403 不可达、沪金/沪银唯一源本就不通）、
  // tencent、yahoo、frankfurter 不再登记；存量库由 retireSources 迁移归档清理，重启不复活
  // end:aigc.
];

// 基础行情：symbol 为统一键；sources 里的 priority 越小优先级越高。
// start:aigc. 外盘金属品种（R03）以新浪 hf_ 系列做备援；其中伦敦铂/钯的新浪备援为纽约口径近似。 // end:aigc.
export const BASE_QUOTES = [
  { symbol: '黄金', name: '黄金', unit: '元/克', decimals: 2, sources: [{ sourceId: 'rtj', priority: 1, kind: 'split', code: 'JZJ_au' }] },
  { symbol: '白银', name: '白银', unit: '元/克', decimals: 3, sources: [{ sourceId: 'rtj', priority: 1, kind: 'split', code: 'JZJ_ag' }] },
  { symbol: '铂金', name: '铂金', unit: '元/克', decimals: 2, sources: [{ sourceId: 'rtj', priority: 1, kind: 'split', code: 'JZJ_pt' }] },
  { symbol: '钯金', name: '钯金', unit: '元/克', decimals: 2, sources: [{ sourceId: 'rtj', priority: 1, kind: 'split', code: 'JZJ_pd' }] },
  { symbol: '铑金', name: '铑金', unit: '元/克', decimals: 2, sources: [{ sourceId: 'rtj', priority: 1, kind: 'split', code: 'RH_JZL' }] },
  { symbol: '黄金TD', name: '黄金T+D', unit: '元/克', decimals: 2, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'Au(T+D)' }] },
  { symbol: '黄金9999', name: '黄金9999', unit: '元/克', decimals: 2, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'Au99.99' }] },
  { symbol: '黄金9995', name: '黄金9995', unit: '元/克', decimals: 2, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'Au99.95' }] },
  { symbol: '白银TD', name: '白银T+D', unit: '元/千克', decimals: 0, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'Ag(T+D)' }] },
  { symbol: '铂金9995', name: '铂金9995', unit: '元/克', decimals: 2, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'Pt99.95' }] },
  { symbol: '美黄金', name: '美黄金', unit: '美元/盎司', decimals: 1, sources: [
    { sourceId: 'rtj', priority: 1, kind: 'plain', code: 'GLNC' },
    // start:aigc. 2026-10-29 第四批：腾讯备援退役——美黄金/美白银退化为 rtj 单源（§17.2 用户已确认接受）
    // end:aigc.
  ] },
  { symbol: '美白银', name: '美白银', unit: '美元/盎司', decimals: 3, sources: [
    { sourceId: 'rtj', priority: 1, kind: 'plain', code: 'SLNC' },
    // start:aigc. 2026-10-29 第四批：腾讯备援退役
    // end:aigc.
  ] },
  { symbol: '美铂金', name: '美铂金', unit: '美元/盎司', decimals: 1, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'PLNC' }] },
  { symbol: '美钯金', name: '美钯金', unit: '美元/盎司', decimals: 1, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'PANC' }] },
  { symbol: '伦敦金', name: '伦敦金', unit: '美元/盎司', decimals: 2, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'XAU' }] },
  { symbol: '伦敦银', name: '伦敦银', unit: '美元/盎司', decimals: 3, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'XAG' }] },
  { symbol: '伦敦铂', name: '伦敦铂', unit: '美元/盎司', decimals: 2, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'XAP' }] },
  { symbol: '伦敦钯', name: '伦敦钯', unit: '美元/盎司', decimals: 2, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'XPD' }] },
  { symbol: '美元指数', name: '美元指数', unit: '点', decimals: 2, sources: [
    // start:aigc. 2026-10-28 换源：新浪 DINIW 机房 403 → 见闻 DXY.OTC（口径与新浪同源，
    // 日高日低精确一致）为主源；iTick DXY 为最终备援（免费版 5 次/分钟限频，口径存在 ~0.3 观测偏差）
    { sourceId: 'wscn', priority: 1, kind: 'wscn', code: 'DXY.OTC' },
    { sourceId: 'itick', priority: 2, kind: 'itick', code: 'DXY', staleMs: ITICK_STALE_MS },
    // end:aigc.
  ] },
  { symbol: '美元兑离岸', name: '美元兑离岸人民币', unit: '', decimals: 4, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'USDCNH' }] },
  { symbol: '美元兑港元', name: '美元兑港元', unit: '', decimals: 4, sources: [
    // start:aigc. 2026-10-28 换源：新浪 fx_susdhkd 机房 403 → 见闻 USDHKD.OTC（实时秒级，
    // 与新浪值基本一致），港金公式（伦敦金×港汇×37.429/31.1034768×0.99）由此复活；
    // 2026-10-29 第四批：frankfurter 备援退役，退化为 wscn 单源（§17.2 接受）
    { sourceId: 'wscn', priority: 1, kind: 'wscn', code: 'USDHKD.OTC' },
    // end:aigc.
  ] },
  // start:aigc. 2026-10-29 沪金/沪银主力复活（iTick 内盘期货）：sina 退役后经实测 iTick
  // future 端点（region=CN，code=AU/AG）可返回主力连续实时行情——沪金 868.10 与黄金T+D
  // 867.44 仅差 0.66、沪银 12815 与白银T+D 12857 差 42，量级与口径正确（时间戳为当前时刻）。
  // 免费版配额 5 次/分钟且按 code 逐条请求：本适配器 3 码共用 45 秒轮询 + 13 秒逐请求间隔（见 itick.mjs）。
  // 次主力无数据源，不登记（避免页面出现"缺少数据"行）
  { symbol: '沪金主力', name: '沪金主力', unit: '元/克', decimals: 2, sources: [
    { sourceId: 'itick', priority: 1, kind: 'itick', code: 'AU', staleMs: ITICK_STALE_MS },
  ] },
  { symbol: '沪银主力', name: '沪银主力', unit: '元/千克', decimals: 1, sources: [
    { sourceId: 'itick', priority: 1, kind: 'itick', code: 'AG', staleMs: ITICK_STALE_MS },
  ] },
  // end:aigc.
];

// 业务品类：由 Task 4 从 defaults.json 迁移进 SQLite，seed 不硬编码。
// 此处仅占位，保证 catalog.test.mjs 结构稳定。
export const CATEGORIES = [];
