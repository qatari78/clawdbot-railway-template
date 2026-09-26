import fs from "node:fs";
import path from "node:path";
import { appendEvent, researchPaths, uuidv7 } from "./jarvis-research-system-v1.js";
import { resolveOpenRouterKeyForRuntime } from "./openrouter-key-audit.js";

function stateDir(){return process.env.OPENCLAW_STATE_DIR?.trim()||"/data/.openclaw";}
function configPath(){return process.env.OPENCLAW_CONFIG_PATH?.trim()||path.join(stateDir(),"openclaw.json");}
function modelSlug(v){return String(v||"").replace(/^openrouter\//,"");}
function words(v){
  return Array.from(new Set(String(v||"").toLowerCase().match(/[a-z0-9\u0600-\u06ff]{4,}/g)||[])).slice(0,40);
}
function bestContext(text,needles,maxChars=5000){
  const raw=String(text||"");
  if(!raw)return "";
  const keys=words(needles);
  if(!keys.length)return raw.slice(0,maxChars);
  const win=2200,step=900;
  let best="",score=-1;
  for(let i=0;i<raw.length;i+=step){
    const chunk=raw.slice(i,i+win);
    const lc=chunk.toLowerCase();
    let s=0;
    for(const k of keys)if(lc.includes(k))s++;
    if(s>score){score=s;best=chunk;}
    if(i+win>=raw.length)break;
  }
  return best.slice(0,maxChars);
}
function readJson(p){return JSON.parse(fs.readFileSync(p,"utf8"));}
function atomicWrite(p,body){
  fs.mkdirSync(path.dirname(p),{recursive:true,mode:0o700});
  const t=p+".tmp-"+process.pid+"-"+Date.now();
  fs.writeFileSync(t,body,{encoding:"utf8",mode:0o600});
  fs.renameSync(t,p);
}
function buildCases(merge,verification){
  const sourceMeta=verification?.sources||{};
  const targets=(merge.claims||[]).filter(c=>c.materiality==="high"||c.ledger_status==="contested").slice(0,30);
  return targets.map(c=>{
    const contexts=[];
    for(const e of (c.evidence||[]).slice(0,3)){
      const sourceKey=e.source_key;
      const meta=sourceMeta[sourceKey]||{};
      let text="";
      try{if(meta.text_cache_path)text=fs.readFileSync(meta.text_cache_path,"utf8");}catch{}
      const context=bestContext(text,[c.statement,e.paraphrase,e.locator].filter(Boolean).join(" "));
      contexts.push({
        source_key:sourceKey||null,
        source_url:meta.final_url||meta.url||null,
        locator:e.locator||null,
        evidence_paraphrase:e.paraphrase||null,
        source_context:context||null,
        mechanical_source_ok:meta.ok===true
      });
    }
    return{
      merged_claim_id:c.merged_claim_id,
      statement:c.statement,
      basis:c.basis,
      materiality:c.materiality,
      ledger_status:c.ledger_status,
      evidence:contexts
    };
  });
}
async function callSupportModel({apiKey,cases}){
  const model=process.env.JARVIS_RESEARCH_SUPPORT_MODEL?.trim()||"openrouter/google/gemini-3.8-flash";
  const schema={
    name:"jarvis_support_check",
    strict:true,
    schema:{
      type:"object",additionalProperties:false,
      properties:{
        results:{
          type:"array",
          items:{
            type:"object",additionalProperties:false,
            properties:{
              merged_claim_id:{type:"string"},
              verdict:{type:"string",enum:["SUPPORTS","PARTIAL","NOT_SUPPORTED","UNVERIFIABLE"]},
              confidence:{type:"string",enum:["high","medium","low"]},
              reason:{type:"string"},
              usable_source_keys:{type:"array",items:{type:"string"}}
            },
            required:["merged_claim_id","verdict","confidence","reason","usable_source_keys"]
          }
        }
      },
      required:["results"]
    }
  };
  const body={
    model:modelSlug(model),
    messages:[
      {role:"system",content:[
        "You are a narrow evidence-entailment checker.",
        "Judge only whether the supplied source context supports each claim. Do not use outside knowledge.",
        "SUPPORTS = the provided context directly supports the material claim.",
        "PARTIAL = context supports only part of the claim or needs a material qualification.",
        "NOT_SUPPORTED = context is inconsistent with, irrelevant to, or insufficient for the stated claim despite being readable.",
        "UNVERIFIABLE = no usable source context was supplied.",
        "Do not reward repeated copies of one source. Be strict with numbers, dates, scope and causal language."
      ].join("\n")},
      {role:"user",content:JSON.stringify({task:"Check claim support from supplied evidence only.",cases})}
    ],
    response_format:{type:"json_schema",json_schema:schema},
    reasoning:{effort:"medium"},
    temperature:0,
    ...(process.env.JARVIS_PRIVACY_ROUTING?.trim()==="off"?{}:{provider:{data_collection:"deny"}})
  };
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),5*60*1000);
  let res,raw="";
  try{
    res=await fetch("https://openrouter.ai/api/v1/chat/completions",{
      method:"POST",
      headers:{Authorization:`Bearer ${apiKey}`,"Content-Type":"application/json","HTTP-Referer":"https://railway.app","X-Title":"Jarvis Evidence Support"},
      body:JSON.stringify(body),signal:controller.signal
    });
    raw=await res.text(); // R12: the time limit covers the answer too
  }finally{clearTimeout(timer);}
  let data=null;try{data=JSON.parse(raw);}catch{}
  // R12: clear errors instead of a bare "Unexpected end of JSON input" (26 Sep: an empty answer
  // here failed a whole Counsel research run after both researchers had succeeded).
  const fail=(message)=>Object.assign(new Error(message),{cost:Number(data?.usage?.cost||0)});
  if(!res.ok)throw fail(data?.error?.message||data?.message||("HTTP "+res.status));
  if(!data||typeof data!=="object")throw fail(`OpenRouter's reply was cut off or not JSON (${raw.trim().length} bytes)`);
  if(data.error)throw fail("provider error: "+String(data.error?.message||data.error?.code||"unknown").slice(0,200));
  const content=data?.choices?.[0]?.message?.content;
  const text=Array.isArray(content)?content.map(x=>x?.text||x?.content||"").join(""):String(content||"");
  if(!text.trim())throw fail(`the support model returned an empty answer (finish_reason ${data?.choices?.[0]?.finish_reason||"unknown"})`);
  let parsed;
  try{parsed=JSON.parse(text);}catch(err){throw fail("the support model's answer was not valid JSON ("+String(err?.message||err).slice(0,120)+")");}
  return{model:data?.model||modelSlug(model),provider:data?.provider??null,usage:data?.usage??null,results:parsed.results||[]};
}

export async function semanticSupportCheck(briefId){
  const p=researchPaths();
  const merge=readJson(path.join(p.merges,briefId+".json"));
  let verification=null;
  try{verification=readJson(path.join(p.verifications,briefId+".json"));}catch{}
  const cases=buildCases(merge,verification);
  const dir=path.join(p.root,"ledger","semantic-verifications");
  const dst=path.join(dir,briefId+".json");
  if(!cases.length){
    const empty={schema:"jarvis-research-semantic-verification-v1.1",semantic_verification_id:uuidv7(),brief_id:briefId,generated_at:new Date().toISOString(),model:null,provider:null,usage:null,results:[],summary:{checked:0,supports:0,partial:0,not_supported:0,unverifiable:0}};
    atomicWrite(dst,JSON.stringify(empty,null,2)+"\n"); return{...empty,path:dst};
  }
  const auth=await resolveOpenRouterKeyForRuntime({stateDir:stateDir(),configPath:configPath()});
  if(!auth.key)throw new Error("OpenRouter credential unavailable for semantic support check");
  const checked=await callSupportModel({apiKey:auth.key,cases});
  const summary={
    checked:checked.results.length,
    supports:checked.results.filter(x=>x.verdict==="SUPPORTS").length,
    partial:checked.results.filter(x=>x.verdict==="PARTIAL").length,
    not_supported:checked.results.filter(x=>x.verdict==="NOT_SUPPORTED").length,
    unverifiable:checked.results.filter(x=>x.verdict==="UNVERIFIABLE").length
  };
  const out={
    schema:"jarvis-research-semantic-verification-v1.1",
    semantic_verification_id:uuidv7(),brief_id:briefId,generated_at:new Date().toISOString(),
    model:checked.model,provider:checked.provider,usage:checked.usage,results:checked.results,summary,
    note:"Evidence-entailment check using only supplied cached source context; no outside knowledge or browsing."
  };
  atomicWrite(dst,JSON.stringify(out,null,2)+"\n");
  appendEvent("semantic-support-completed",{brief_id:briefId,semantic_verification_id:out.semantic_verification_id,...summary,cost_usd:Number(out.usage?.cost||0)});
  return{...out,path:dst};
}

async function cli(){
  const briefId=process.argv[2];
  if(!briefId)throw new Error("Usage: node jarvis-research-support-v1.js <brief-id>");
  const r=await semanticSupportCheck(briefId);
  process.stdout.write(JSON.stringify(r,null,2)+"\n");
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname)){
  cli().catch(err=>{process.stderr.write("[jarvis-research-support-v1] "+String(err?.message||err)+"\n");process.exit(1);});
}
