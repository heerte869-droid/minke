const overview='https://platform.openai.com/settings/organization/billing/overview';
export const billingAccess={origins:['https://platform.openai.com/*']};

export function isOverview(url){
  try {
    const u=new URL(url);
    return !u.username && !u.password && !u.hash && u.origin==='https://platform.openai.com' &&
      /^\/settings\/organization\/billing\/overview\/?$/.test(u.pathname);
  } catch {return false;}
}

// Serialized by chrome.scripting into the top frame's isolated world.
export function readOverview(expected){
  if(location.origin+location.pathname.replace(/\/$/,'')!==expected || location.hash)return {state:'page_changed'};
  if(!document.body)return {state:'loading',pageReady:document.readyState,visibility:document.visibilityState};
  const canonical=s=>s.normalize('NFKC').replace(/\s+/g,' ').trim().replace(/[:：]$/,'').trim().toLowerCase();
  const accepted=['Wallet balance','钱包余额','錢包餘額','Credit balance','Available balance','信用余额','可用余额','账户余额','帳戶餘額','可用餘額','信用餘額','点数余额','点数余额（美元）','信用额度余额','余额','餘額'];
  const remaining=['Credit remaining','Credits remaining','Remaining credit','Remaining credits','Remaining balance','Credit balance (USD)','剩余额度','剩余点数','剩余信用额度','剩余积分','剩余余额','剩餘額度','剩餘點數','剩餘餘額'];
  const labels=new Set([...accepted,...remaining].map(canonical));
  const related=new Set();
  const englishWords=/^(?:(?:credit|credits|balance|remaining|current|prepaid|available|wallet|total|your|left|amount|account|funds|grants?|usage|limit|budget|trial|free|payment|plan|as|you|pay|go|usd)(?: |$))+$/;
  const chineseWords=/^(?:剩余|剩餘|可用|当前|當前|预付|預付|账户|帳戶|帐户|信用|点数|點數|积分|積分|额度|額度|余额|餘額|资金|資金|金额|金額|赠送|贈送|赠金|赠款|试用|試用|免费|免費|美元|用量|预算|預算|限额|限額|总|總|的|信用額|信用额)+$/;

  const control='button,a,input,textarea,select,[role=button],[role=link],[hidden],[aria-hidden=true],script,style';
  const visible=(node,skipControls=true)=>{
    if(!node || node.closest(skipControls?control:'[hidden],[aria-hidden=true],script,style') || getComputedStyle(node).visibility!=='visible')return false;
    if(node.checkVisibility && !node.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}))return false;
    return node.getClientRects().length>0;
  };
  const amount=/^(?:USD\s*|US\$\s*|\$\s*)(-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,6})?)$/;
  const flags={loginControl:false,billingHeading:false,accessError:false,loading:false,moneyText:false,hasPageText:false,
    payAsYouGo:false,trialHeading:false,verificationPage:false,embeddedFrame:[...document.querySelectorAll('iframe')].some(el=>visible(el,false))};
  const labelsSeen=new Set(), values=[], inspected=new Set();
  const nodes=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  while(nodes.nextNode()){
    const text=nodes.currentNode, el=text.parentElement, token=text.data.trim();
    if(!token || !visible(el,false))continue;
    flags.hasPageText=true;
    if(token.length>160)continue;
    const word=canonical(token);
    if(word.length<=44 && (englishWords.test(word)||chineseWords.test(word)) && related.size<16)related.add(word);
    if(/^(?:pay as you go|pay-as-you-go|按量付费|按使用量付费|随用随付|按用量付費)$/.test(word))flags.payAsYouGo=true;
    if(/^(?:free trial|trial credits?|免费试用|免費試用)$/.test(word))flags.trialHeading=true;
    if(/^(log in|sign in|login|登录|登入|登錄|登录或注册)$/.test(word))flags.loginControl=true;
    if(/^(billing|billing overview|billing settings|账单|账单概览|帳單|帳單概覽)$/.test(word))flags.billingHeading=true;
    if(/access denied|permission denied|unable to load|something went wrong|forbidden|没有权限|拒绝访问|加载失败|出了点问题/.test(word))flags.accessError=true;
    if(/^(loading[. …]*|加载中[. …]*|正在加载[. …]*)$/.test(word))flags.loading=true;
    if(/verify (?:that )?you are human|checking your browser|验证您是人类|验证您是否是真人|正在验证您的浏览器/.test(word))flags.verificationPage=true;
    if(!visible(el))continue;
    if(amount.test(token))flags.moneyText=true;
    let labelNode=el, label=word;
    if(!labels.has(label)){
      if(!/(credit|available|balance|余额|餘額)/i.test(word))continue;
      label=canonical(el.textContent||'');
      if(!labels.has(label) && el.parentElement){labelNode=el.parentElement;label=canonical(labelNode.textContent||'');}
      if(!labels.has(label))continue;
    }
    if(inspected.has(labelNode))continue;
    inspected.add(labelNode);labelsSeen.add(label);
    let group=labelNode;
    for(let depth=0;depth<4 && group && group!==document.body;depth++,group=group.parentElement){
      const walker=document.createTreeWalker(group,NodeFilter.SHOW_TEXT), parts=[];
      while(walker.nextNode() && parts.length<12){
        const n=walker.currentNode, value=n.data.trim();
        if(value && visible(n.parentElement))parts.push(value);
      }
      const joined=parts.join(' ').normalize('NFKC').replace(/\s+/g,' ').trim();
      if(canonical(joined)===label)continue;
      const leading=joined.toLowerCase();
      if(!leading.startsWith(label))continue;
      let match=amount.exec(joined.slice(label.length).replace(/^\s*[:：]?\s*/,''));
      if(!match && ['wallet balance','钱包余额','錢包餘額'].includes(label) && canonical(parts[0]||'')===label && parts.length>=3 && parts.length<=4){
        // The official wallet card can interpose a short explanation of organization funds.
        const note=parts[1];
        const explainsFunds=/\b(?:funds|credits?)\b/i.test(note) && /\b(?:organi[sz]ation|wallet)\b/i.test(note) ||
          /(?:组织|組織|钱包|錢包)/.test(note) && /(?:资金|資金|余额|餘額)/.test(note);
        if(explainsFunds && note.length<=240 && !/[\d$]|budget|limit|spent|spend|cost|usage|free trial|限额|用量|预算|试用/i.test(note))
          match=amount.exec(parts.slice(2).join(' ').trim());
      }
      if(match){values.push({label:[...accepted,...remaining].find(v=>canonical(v)===label),amount:match[1].replaceAll(',',''),currency:'USD'});break;}
    }
  }
  const explicitWallet=values.length===1 && ['wallet balance','钱包余额','錢包餘額'].includes(canonical(values[0].label));
  const trialOnly=!explicitWallet && flags.trialHeading;
  const state=values.length===1 && labelsSeen.size===1?(trialOnly?'trial_credit_only':'read'):labelsSeen.size>1 || values.length>1?'ambiguous_balance':
    labelsSeen.size?'amount_not_ready':flags.verificationPage?'verification_page':flags.accessError?'page_error':flags.loginControl&&!flags.billingHeading?'login_prompt':
    !flags.hasPageText?'empty_document':flags.loading?'loading':'label_not_found';
  return {state,pageReady:document.readyState,visibility:document.visibilityState,labels:[...labelsSeen],billingTerms:[...related],pageSignals:flags,...(state==='read'?values[0]:{})};
}

export async function observeBilling(assertCurrent){
  if(!await chrome.permissions.contains(billingAccess))return {state:'needs_site_access',reason:'在 Minke 扩展弹窗点「允许读取官方账单页」，再重新读取。'};
  const candidates=async()=>(await chrome.tabs.query({url:overview+'*',windowType:'normal'})).filter(t=>!t.incognito && isOverview(t.url) && (!t.pendingUrl || t.pendingUrl===t.url));
  assertCurrent();const tabs=await candidates();
  if(tabs.length!==1)return {state:tabs.length?'multiple_overviews':'no_overview',count:tabs.length};
  const id=tabs[0].id,deadline=Date.now()+4600;let documentId,prior,last;
  do{
    assertCurrent();
    const [row]=await chrome.scripting.executeScript({target:documentId?{tabId:id,documentIds:[documentId]}:{tabId:id,frameIds:[0]},world:'ISOLATED',func:readOverview,args:[overview]});
    if(!row?.documentId||!row.result || row.result.state==='page_changed')return {state:'page_changed'};
    documentId=row.documentId;
    const current=await candidates();assertCurrent();
    if(current.length!==1||current[0].id!==id||current[0].url!==tabs[0].url)return {state:'page_changed'};
    last={...row.result,tabActive:current[0].active,tabId:String(id),source:overview,observedAt:new Date().toISOString()};
    if(last.state==='read' && prior?.state==='read' && prior.amount===last.amount && prior.label===last.label)return last;
    prior=last;await new Promise(r=>setTimeout(r,350));
  }while(Date.now()<deadline);
  return last?.state==='read'?{state:'amount_not_ready',tabActive:last.tabActive,source:overview}:last;
}
