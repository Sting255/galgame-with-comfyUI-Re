/** Semantic anchors are offsets into ORIGINAL messages, never extra API roles.
 * Only an explicitly certified prefix may host cache-stable lore. Unknown task
 * text terminates that prefix even if a recognizable persona occurs later.
 */
export function buildPromptProfile(messages, options = {}) {
  const texts = messages.map(m => typeof m.content === 'string' ? m.content : '');
  const firstUser = messages.findIndex(m => m.role !== 'system');
  const prefixEnd = firstUser < 0 ? messages.length : firstUser;
  const candidates = [...new Set((options.personaTexts || []).filter(Boolean))].sort((a,b) => b.length-a.length);
  const personas = [];
  const lastUser=messages.findLastIndex(m=>m.role==='user');
  for (let index=0; index<messages.length; index++) {
    if(messages[index].role!=='system' && index!==lastUser) continue;
    for (const text of candidates) {
      const offset = texts[index].indexOf(text);
      if (offset >= 0 && !personas.some(p => p.index===index && offset>=p.start && offset+text.length<=p.end)) {
        personas.push({index,start:offset,end:offset+text.length,text});
      }
    }
  }
  personas.sort((a,b)=>a.index-b.index || a.start-b.start);
  // The caller may identify a composite group card or a transformed persona.
  const first = personas[0];
  const last = personas.at(-1);
  const point = (index,offset,label) => ({index,offset,label});
  const anchors = {};
  if (first) anchors.beforeCharacter=point(first.index,first.start,'角色定义之前');
  if (last) anchors.afterCharacter=point(last.index,last.end,'角色定义之后');
  let world;
  for(let index=0;index<prefixEnd;index++) {
    if(options.worldText) {
      const start=texts[index].indexOf(options.worldText);
      if(start>=0) { world={index,start,end:start+options.worldText.length}; break; }
    }
    const match=/<world_setting>[\s\S]*?<\/world_setting>/.exec(texts[index]);
    if(match && !options.worldText) { world={index,start:match.index,end:match.index+match[0].length}; break; }
  }
  if(world) {
    anchors.beforeAuthorNote=point(world.index,world.start,'世界观之前（作者注适配）');
    anchors.afterAuthorNote=point(world.index,world.end,'世界观之后（作者注适配）');
  }
  const known=[...new Set([...(options.staticTexts || []),...candidates,options.worldText].filter(Boolean))].sort((a,b)=>b.length-a.length);
  let safe=point(0,0,'已确认稳定区末尾');
  outer: for(let index=0;index<prefixEnd;index++) {
    if(typeof messages[index].content!=='string') { safe=point(index,0,'多模态内容之前'); break; }
    let offset=0;
    while(offset<texts[index].length) {
      const whitespace=/^\s+/.exec(texts[index].slice(offset));
      if(whitespace) offset+=whitespace[0].length;
      if(offset===texts[index].length) break;
      const match=known.find(text=>texts[index].startsWith(text,offset));
      if(!match) { safe=point(index,offset,'首个动态或未确认内容之前'); break outer; }
      offset+=match.length;
    }
    safe=point(index,texts[index].length,'已确认稳定区末尾');
  }
  if(options.cacheBoundary) safe={...options.cacheBoundary,label:options.cacheBoundary.label || '业务稳定区末尾'};
  if(safe.index>0 && safe.offset===0 && messages[safe.index-1]?.role==='system') safe={...safe,index:safe.index-1,offset:texts[safe.index-1].length};
  const start=point(0,0,'系统提示开头');
  const stableFallback=options.stableTarget || safe;
  const beforeOrEqual=(a,b)=>a.index<b.index || (a.index===b.index && (a.offset||0)<=(b.offset||0));
  const stableAnchors={};
  for(const [name,target] of Object.entries(anchors)) {
    stableAnchors[name]=beforeOrEqual(target,safe) ? target : {...stableFallback,label:`${target.label} → 稳定区末尾`};
  }
  // No real example conversation exists in Linshe. Its two groups share a
  // boundary but are ordered before/after, without inventing dialogue turns.
  stableAnchors.beforeExamples={...safe,label:'稳定示例区前组（历史/动态内容之前）'};
  stableAnchors.afterExamples={...safe,label:'稳定示例区后组（历史/动态内容之前）'};
  if(!world) {
    anchors.beforeAuthorNote=start;
    anchors.afterAuthorNote={...safe,label:'无世界观：稳定区末尾'};
    stableAnchors.beforeAuthorNote=start;
    stableAnchors.afterAuthorNote=anchors.afterAuthorNote;
  }
  if(!first) {
    anchors.beforeCharacter={...stableFallback,label:'未提供独立角色定义：稳定区末尾'};
    anchors.afterCharacter=anchors.beforeCharacter;
    stableAnchors.beforeCharacter=anchors.beforeCharacter;
    stableAnchors.afterCharacter=anchors.afterCharacter;
  }
  return {anchors,stableAnchors,stableTarget:stableFallback,cacheBoundary:safe,personas};
}
