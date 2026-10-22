export const CATALOG = [
 ['黄金','JZJ_au',true],['白银','JZJ_ag',true],['铂金','JZJ_pt',true],['钯金','JZJ_pd',true],['铑金','RH_JZL',true],
 ['黄金TD','Au(T+D)'],['黄金9999','Au99.99'],['黄金9995','Au99.95'],['白银TD','Ag(T+D)'],['铂金9995','Pt99.95'],
 ['美黄金','GLNC'],['美白银','SLNC'],['美铂金','PLNC'],['美钯金','PANC'],['伦敦金','XAU'],['伦敦银','XAG'],['伦敦铂','XAP'],['伦敦钯','XPD'],['美元兑离岸','USDCNH'],
 ['港金',null],['美元指数',null],['公斤条',null],['公斤铂',null],['公斤钯',null],['公斤银',null],['沪金主力',null],['沪金次主力',null],['沪银主力',null],['沪银次主力',null],['美铑金',null],
].map(([name,code,split=false])=>({name,code,split}));
export const FIELD_LABELS={buy:'回购价',sell:'销售价',high:'最高价',low:'最低价'};
