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
export const SOURCES = [
  { id: 'rtj', name: '融通金', type: 'websocket', enabled: true },
  { id: 'sina', name: '新浪', type: 'http', enabled: true },
  { id: 'yahoo', name: 'Yahoo Finance', type: 'http', enabled: false },
  { id: 'frankfurter', name: 'Frankfurter', type: 'http', enabled: false },
];

// 基础行情：symbol 为统一键；sources 里的 priority 越小优先级越高。
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
  { symbol: '美黄金', name: '美黄金', unit: '美元/盎司', decimals: 1, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'GLNC' }] },
  { symbol: '美白银', name: '美白银', unit: '美元/盎司', decimals: 3, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'SLNC' }] },
  { symbol: '美铂金', name: '美铂金', unit: '美元/盎司', decimals: 1, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'PLNC' }] },
  { symbol: '美钯金', name: '美钯金', unit: '美元/盎司', decimals: 1, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'PANC' }] },
  { symbol: '伦敦金', name: '伦敦金', unit: '美元/盎司', decimals: 2, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'XAU' }] },
  { symbol: '伦敦银', name: '伦敦银', unit: '美元/盎司', decimals: 3, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'XAG' }] },
  { symbol: '伦敦铂', name: '伦敦铂', unit: '美元/盎司', decimals: 2, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'XAP' }] },
  { symbol: '伦敦钯', name: '伦敦钯', unit: '美元/盎司', decimals: 2, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'XPD' }] },
  { symbol: '美元指数', name: '美元指数', unit: '点', decimals: 2, sources: [
    { sourceId: 'sina', priority: 1, kind: 'sina', code: 'DINIW' },
    { sourceId: 'yahoo', priority: 2, kind: 'yahoo' },
  ] },
  { symbol: '美元兑离岸', name: '美元兑离岸人民币', unit: '', decimals: 4, sources: [{ sourceId: 'rtj', priority: 1, kind: 'plain', code: 'USDCNH' }] },
  { symbol: '美元兑港元', name: '美元兑港元', unit: '', decimals: 4, sources: [
    { sourceId: 'sina', priority: 1, kind: 'sina', code: 'fx_susdhkd' },
    { sourceId: 'frankfurter', priority: 2, kind: 'frankfurter' },
  ] },
  { symbol: '沪金主力', name: '沪金主力', unit: '元/克', decimals: 2, sources: [{ sourceId: 'sina', priority: 1, kind: 'sina', code: 'nf_AU0' }] },
  { symbol: '沪银主力', name: '沪银主力', unit: '元/千克', decimals: 1, sources: [{ sourceId: 'sina', priority: 1, kind: 'sina', code: 'nf_AG0' }] },
];

// 业务品类：由 Task 4 从 defaults.json 迁移进 SQLite，seed 不硬编码。
// 此处仅占位，保证 catalog.test.mjs 结构稳定。
export const CATEGORIES = [];
