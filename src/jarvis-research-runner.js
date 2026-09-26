import fs from "node:fs";
import path from "node:path";
import {
  appendEvent,
  buildResearchDossier,
  ingestResearchPacket,
  mergeResearchBrief,
  researchPaths,
  uuidv7,
  writeResearchBrief,
} from "./jarvis-research-system-v1.js";
import { resolveOpenRouterKeyForRuntime } from "./openrouter-key-audit.js";
import { verifyResearchSources } from "./jarvis-research-verification-v1.js";
import { semanticSupportCheck } from "./jarvis-research-support-v1.js";

const START="JARVIS_PACKET_START";
const END="JARVIS_PACKET_END";

function stateDir(){return process.env.OPENCLAW_STATE_DIR?.trim()||"/data/.openclaw";}
function configPath(){return process.env.OPENCLAW_CONFIG_PATH?.trim()||path.join(stateDir(),"openclaw.json");}
function modelSlug(v){return String(v||"").replace(/^openrouter\//,"");}
function assistantText(message){
  const content=message?.content;
  if(typeof content==="string")return content;
  if(Array.isArray(content))return content.map(x=>typeof x==="string"?x:(x?.text||x?.content||"")).join("\n");
  return String(content||"");
}
function extractPacket(text){
  const value=String(text||"");
  const a=value.indexOf(START), b=value.indexOf(END,a+START.length);
  if(a>=0&&b>a){
    const body=value.slice(a+START.length,b).trim().replace(/^\`\`\`(?:json)?/i,"").replace(/\`\`\`$/,"").trim();
    return JSON.parse(body);
  }
  const trimmed=value.trim().replace(/^\`\`\`(?:json)?/i,"").replace(/\`\`\`$/,"").trim();
  const packet=JSON.parse(trimmed);
  if(!packet?.brief_id||!packet?.researcher)throw new Error("Model response was not a research packet");
  return packet;
}
function roleSystem(researcher){
  if(researcher==="verifier"){
    return [
      "You are Jarvis Verifier, an independent primary-source-first evidence researcher.",
      "Research facts, not advice. Prefer laws/regulators, official documentation, filings, original datasets/papers and first-party announcements.",
      "Open underlying sources. Search snippets are discovery only.",
      "For every material claim capture a source URL and a precise locator. Keep direct quotes tiny; prefer faithful paraphrase.",
      "Record contradictions and unknowns. Do not reconcile disagreement by guessing.",
      "High-materiality claims require one authoritative primary source or two independent secondary evidence chains when no primary exists.",
      "Do not use prior conclusions, personal memory, another researcher's work, or adviser views."
    ].join("\n");
  }
  return [
    "You are Jarvis Scout, an independent landscape, adversarial and enumeration researcher.",
    "Research facts, not advice. Map the landscape before narrowing and deliberately seek contrary evidence, corrections, failures, regulator actions, lawsuits, retractions and later revisions.",
    "Use secondary sources as leads, then open underlying primary material where available.",
    "Vary queries across synonyms, competing terminology, local names and adjacent categories.",
    "For every material claim capture a source URL and a precise locator. Keep direct quotes tiny; prefer faithful paraphrase.",
    "Record contradictions and unknowns. Do not reconcile disagreement by guessing.",
    "Do not use prior conclusions, personal memory, another researcher's work, or adviser views."
  ].join("\n");
}
function packetContract(brief,researcher){
  return [
    "Return evidence only, no recommendation.",
    "Use web research for this commission and open/fetch important underlying pages before making material claims.",
    "Every source must have a stable source_id you create. Every evidence item must reference one source_id via source_ref.",
    "claim_topic must be a short neutral proposition/topic label shared by claims about the same proposition.",
    "polarity must be supports, refutes, mixed, or na.",
    "basis must be direct, derived, or inference. For derived claims include derived_from_claim_ids and formula.",
    "Do not mark a claim verified unless its evidence actually supports it.",
    "Memo maximum 600 words.",
    "",
    "Return ONLY this sentinel block with valid JSON between the sentinels:",
    START,
    JSON.stringify({
      schema:"jarvis-research-packet-v1.1",
      brief_id:brief.brief_id,
      researcher,
      memo:"compact evidence memo",
      claims:[{
        statement:"factual claim",
        claim_topic:"neutral proposition label",
        polarity:"supports",
        basis:"direct",
        materiality:"high",
        status:"verified",
        evidence:[{source_ref:"S1",type:"text",locator:"section/page/table/heading",paraphrase:"short precise supporting evidence"}],
        derived_from_claim_ids:[],
        formula:null
      }],
      sources:[{
        source_id:"S1",url:"https://example.com/source",title:"source title",publisher:"publisher",source_class:"primary",
        published_at:null,retrieved_at:new Date().toISOString(),origin_url:null,immutable:false,content_hash:null,derived_from:[]
      }],
      open_questions:[{question:"material remaining uncertainty",materiality:"medium",why:"why it matters"}]
    },null,2),
    END
  ].join("\n");
}
function toolBudget(level,researcher){
  if(level==="heavy") return 70;
  if(level==="verifier") return 25;
  return researcher==="verifier"?25:30;
}
// Salem AI (Claude, 2026-09-26) — R12. A researcher call that fails for a transient reason (empty
// or cut-off answer, provider error, HTTP 408/429/5xx, dropped connection) is retried once, for that
// researcher only; the other researcher's paid work is kept. Observed 26 Sep: one dual run failed
// with a bare "Unexpected end of JSON input" (an empty or cut-off answer), and the whole run —
// including the researcher that had succeeded — was paid for again.
export class ResearchCallError extends Error{
  constructor(message,{retryable=false,cost=0}={}){super(message);this.name="ResearchCallError";this.retryable=retryable;this.cost=Number(cost)||0;}
}
function finishReasonOf(data){const c=data?.choices?.[0];return c?.finish_reason||c?.native_finish_reason||"unknown";}
function callTimeoutMs(level){return level==="heavy"?20*60*1000:10*60*1000;}
// All attempts of one researcher fit in this window; the rooms skill runs the runner with a 25-min
// exec timeout, and the source and support checks run after the calls.
const CALL_WINDOW_MS=22*60*1000;
const RETRY_MIN_MS=5*60*1000;
export async function callResearch({apiKey,model,researcher,brief,searchEngine,level,timeoutMs,fetchImpl=globalThis.fetch}){
  const requestBody={
    model:modelSlug(model),
    messages:[
      {role:"system",content:roleSystem(researcher)},
      {role:"user",content:[
        "PRIMARY RESEARCH COMMISSION — fresh isolated request.",
        "Another researcher may receive the same neutral brief independently. Do not seek or infer their work.",
        "",
        "NEUTRAL BRIEF",
        JSON.stringify(brief,null,2),
        "",
        packetContract(brief,researcher)
      ].join("\n")}
    ],
    reasoning:{effort:"high"},
    tools:[
      {type:"openrouter:web_search",parameters:{
        engine:searchEngine,
        max_results:8,
        max_total_results:level==="heavy"?80:40,
        search_context_size:level==="heavy"?"high":"medium"
      }},
      {type:"openrouter:web_fetch",parameters:{engine:"openrouter",max_content_tokens:level==="heavy"?50000:30000}}
    ],
    tool_choice:"required",
    max_tool_calls:toolBudget(level,researcher),
    temperature:0.1,
    // D6 privacy: only providers that do not collect data (JARVIS_PRIVACY_ROUTING=off to disable).
    ...(process.env.JARVIS_PRIVACY_ROUTING?.trim()==="off"?{}:{provider:{data_collection:"deny"}})
  };
  const limitMs=Number(timeoutMs)>0?Number(timeoutMs):callTimeoutMs(level);
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),limitMs);
  let res,raw="";
  try{
    res=await fetchImpl("https://openrouter.ai/api/v1/chat/completions",{
      method:"POST",
      headers:{
        Authorization:`Bearer ${apiKey}`,
        "Content-Type":"application/json",
        "HTTP-Referer":"https://railway.app",
        "X-Title":"Jarvis Research"
      },
      body:JSON.stringify(requestBody),
      signal:controller.signal
    });
    // Read the body inside the time limit too: OpenRouter can answer 200 at once and send the
    // body only when the model has finished.
    raw=await res.text();
  }catch(err){
    if(controller.signal.aborted)throw new ResearchCallError(`${researcher}: no complete answer within ${Math.round(limitMs/60000)} min`,{retryable:false});
    throw new ResearchCallError(`${researcher}: connection to OpenRouter failed (${String(err?.message||err).slice(0,160)})`,{retryable:true});
  }finally{clearTimeout(timer);}
  let data=null;try{data=JSON.parse(raw);}catch{}
  const cost=Number(data?.usage?.cost||0);
  if(!res.ok){
    const status=Number(res.status);
    throw new ResearchCallError(`${researcher} OpenRouter request failed: ${data?.error?.message||data?.message||("HTTP "+status)}`,{retryable:status===408||status===429||status>=500,cost});
  }
  if(!data||typeof data!=="object")throw new ResearchCallError(`${researcher}: OpenRouter's reply was cut off or not JSON (${raw.trim().length} bytes)`,{retryable:true});
  if(data.error)throw new ResearchCallError(`${researcher}: provider error from OpenRouter: ${String(data.error?.message||data.error?.code||"unknown").slice(0,200)}`,{retryable:true,cost});
  const message=data?.choices?.[0]?.message;
  const text=assistantText(message);
  if(!text.trim())throw new ResearchCallError(`${researcher}: the model returned an empty answer (finish_reason ${finishReasonOf(data)})`,{retryable:true,cost});
  let packet;
  try{packet=extractPacket(text);}
  catch(err){throw new ResearchCallError(`${researcher}: the answer was not a valid research packet (${String(err?.message||err).slice(0,160)}; finish_reason ${finishReasonOf(data)})`,{retryable:true,cost});}
  if(packet.brief_id!==brief.brief_id)throw new ResearchCallError(researcher+" returned wrong brief_id",{cost});
  if(packet.researcher!==researcher)throw new ResearchCallError(researcher+" returned wrong researcher role",{cost});
  const d=data?.usage?.server_tool_use_details||data?.usage?.server_tool_use||{};
  const searchRequests=Number(d.web_search_requests||0);
  const toolCallsRequested=Number(d.tool_calls_requested||0);
  const toolCallsExecuted=Number(d.tool_calls_executed||0);
  const annotationCount=Array.isArray(message?.annotations)?message.annotations.length:0;
  if(searchRequests<1&&annotationCount<1)throw new ResearchCallError(researcher+" completed without observable web research",{cost});
  if(!Array.isArray(packet.sources)||packet.sources.length<1)throw new ResearchCallError(researcher+" returned no sources",{cost});
  return{
    packet,
    telemetry:{
      researcher,model:data?.model||modelSlug(model),provider:data?.provider??null,search_engine:searchEngine,
      search_requests:searchRequests,tool_calls_requested:toolCallsRequested,tool_calls_executed:toolCallsExecuted,
      annotation_count:annotationCount,usage:data?.usage??null
    }
  };
}
// One researcher: first attempt, then at most one retry for a transient failure, both within
// CALL_WINDOW_MS. Resolves {packet, telemetry, attempts, failedCost}; rejects with an Error whose
// message names both attempts and whose failedCost counts what the failed attempts were billed.
export async function researchWithRetry(args,{now=Date.now,sleep=(ms)=>new Promise((r)=>setTimeout(r,ms)),onRetry=()=>{},call=callResearch}={}){
  const start=now();
  const limit=callTimeoutMs(args.level);
  try{
    const r=await call({...args,timeoutMs:limit});
    return{...r,attempts:1,failedCost:0};
  }catch(first){
    const failedCost=Number(first?.cost||0);
    const remaining=start+CALL_WINDOW_MS-now();
    if(!first?.retryable||remaining<RETRY_MIN_MS){
      const e=first instanceof Error?first:new Error(String(first));
      e.failedCost=failedCost;
      throw e;
    }
    try{onRetry(first);}catch{}
    await sleep(5000);
    try{
      const r=await call({...args,timeoutMs:Math.min(limit,remaining-5000)});
      return{...r,attempts:2,failedCost};
    }catch(second){
      const e=new Error(`${String(second?.message||second)} — on the retry, too (first attempt: ${String(first?.message||first).slice(0,200)})`);
      e.failedCost=failedCost+Number(second?.cost||0);
      throw e;
    }
  }
}
export async function runResearchBrief({brief,level="dual",ledgerBriefId=null}){
  if(!["verifier","scout","dual","heavy"].includes(level))throw new Error("level must be verifier, scout, dual, or heavy");
  const p=researchPaths();
  const runId=uuidv7();
  const normalized={...brief};
  normalized.brief_id ||= "research-"+runId;
  normalized.commissioned_at ||= new Date().toISOString();
  normalized.schema="jarvis-research-brief-v1.1";
  writeResearchBrief(normalized);

  const auth=await resolveOpenRouterKeyForRuntime({stateDir:stateDir(),configPath:configPath()});
  if(!auth.key)throw new Error("OpenRouter credential could not be resolved from canonical runtime auth stores");

  // The research seats' models come from the live config (research-01 Verifier, research-02 Scout),
  // so an owner switch (/config set agents.entries.research-0N.model=...) takes effect here too.
  let liveCfg=null;try{liveCfg=JSON.parse(fs.readFileSync(configPath(),"utf8"));}catch{}
  const seatModel=(id)=>{const m=liveCfg?.agents?.entries?.[id]?.model;return typeof m==="string"?m:(m&&typeof m.primary==="string"?m.primary:null);};
  const verifierModel=seatModel("research-01")||process.env.JARVIS_RESEARCH_VERIFIER_MODEL?.trim()||"openrouter/openai/gpt-6-sol";
  const scoutModel=seatModel("research-02")||process.env.JARVIS_RESEARCH_SCOUT_MODEL?.trim()||"openrouter/deepseek/deepseek-v4-flash-0731";
  const verifierSearchEngine=process.env.JARVIS_RESEARCH_VERIFIER_SEARCH_ENGINE?.trim()||"native";
  const scoutSearchEngine=process.env.JARVIS_RESEARCH_SCOUT_SEARCH_ENGINE?.trim()||"perplexity";

  const jobs=[];
  const onRetry=(researcher)=>(err)=>appendEvent("research-call-retry",{brief_id:normalized.brief_id,researcher,error:String(err?.message||err).slice(0,300)});
  if(level!=="scout")jobs.push(researchWithRetry({apiKey:auth.key,model:verifierModel,researcher:"verifier",brief:normalized,searchEngine:verifierSearchEngine,level},{onRetry:onRetry("verifier")}));
  if(level!=="verifier")jobs.push(researchWithRetry({apiKey:auth.key,model:scoutModel,researcher:"scout",brief:normalized,searchEngine:scoutSearchEngine,level},{onRetry:onRetry("scout")}));
  const settled=await Promise.allSettled(jobs);
  const failures=[],telemetry=[],packets=[];
  let failedAttemptCost=0;
  for(const item of settled){
    if(item.status==="rejected"){failures.push(String(item.reason?.message||item.reason));failedAttemptCost+=Number(item.reason?.failedCost||0);continue;}
    const x=item.value;
    failedAttemptCost+=Number(x.failedCost||0);
    x.telemetry.attempts=x.attempts;
    if(ledgerBriefId&&ledgerBriefId!==normalized.brief_id){
      x.packet.research_task_id=normalized.brief_id;
      x.packet.parent_brief_id=ledgerBriefId;
      x.packet.brief_id=ledgerBriefId;
    }
    const ingested=ingestResearchPacket(x.packet);
    packets.push(ingested.packet_id);
    telemetry.push(x.telemetry);
  }
  const pass=failures.length===0&&packets.length===jobs.length;
  const targetBriefId=ledgerBriefId||normalized.brief_id;
  let merge=null,verification=null,semanticVerification=null,dossier=null;
  // R12: the source and support checks are quality checks on evidence already paid for: when one
  // fails, the dossier is still built (without that check) and the failure is reported in
  // check_errors. 26 Sep: an empty answer from the support model ("Unexpected end of JSON input")
  // failed a whole Counsel research run after both researchers had succeeded.
  const checkErrors=[];
  let checkFailedCost=0;
  const runCheck=async(label,fn,tries)=>{
    for(let i=1;i<=tries;i++){
      try{return await fn();}
      catch(err){
        checkFailedCost+=Number(err?.cost||0);
        if(i===tries){checkErrors.push(`${label} failed${tries>1?" twice":""}: ${String(err?.message||err).slice(0,200)}`);return null;}
        await new Promise((r)=>setTimeout(r,3000));
      }
    }
    return null;
  };
  // R12: when one researcher of a dual/heavy run failed even after its retry, the other's evidence
  // still becomes a dossier (as a Verifier-only run would), marked partial — not thrown away.
  if(pass||packets.length>0){
    try{
      merge=mergeResearchBrief(targetBriefId);
      verification=await runCheck("source check",()=>verifyResearchSources(targetBriefId),1);
      semanticVerification=await runCheck("support check",()=>semanticSupportCheck(targetBriefId),2);
      dossier=buildResearchDossier(targetBriefId);
    }catch(err){
      if(pass)throw err;
      failures.push("the partial dossier could not be built: "+String(err?.message||err).slice(0,200));
      merge=verification=semanticVerification=dossier=null;
    }
  }
  const partial=!pass&&Boolean(dossier);
  const researchCost=telemetry.reduce((s,x)=>s+Number(x.usage?.cost||0),0)+failedAttemptCost;
  const supportCost=Number(semanticVerification?.usage?.cost||0)+checkFailedCost;
  const totalCost=researchCost+supportCost;
  const summary={
    schema:"jarvis-research-run-v1.1",run_id:runId,brief_id:targetBriefId,task_brief_id:normalized.brief_id,level,
    ...(normalized.test===true?{test:true}:{}),
    ledger_brief_id:ledgerBriefId||null,
    started_at:normalized.commissioned_at,finished_at:new Date().toISOString(),pass,partial,failures,check_errors:checkErrors,
    packets,telemetry,total_cost_usd:totalCost,failed_attempt_cost_usd:failedAttemptCost,
    merge:merge?{merge_id:merge.merge_id,source_count:merge.source_count,claim_count:merge.claim_count,contradiction_count:merge.contradiction_count}:null,
    verification:verification?{verification_id:verification.verification_id,reachable_sources:verification.reachable_sources,unreachable_sources:verification.unreachable_sources,numeric_mismatches:verification.numeric_mismatches,source_failures:verification.source_failures}:null,
    semantic_support:semanticVerification?{semantic_verification_id:semanticVerification.semantic_verification_id,...semanticVerification.summary,model:semanticVerification.model,cost_usd:Number(semanticVerification.usage?.cost||0)}:null,
    dossier:dossier?{dossier_id:dossier.dossier_id,path:dossier.path}:null
  };
  const runPath=path.join(p.runs,runId+".json");
  fs.writeFileSync(runPath,JSON.stringify(summary,null,2)+"\n",{encoding:"utf8",mode:0o600});
  appendEvent("research-run-completed",{run_id:runId,brief_id:targetBriefId,task_brief_id:normalized.brief_id,level,pass,partial,total_cost_usd:totalCost});
  return{summary,dossier};
}
async function cli(){
  const [cmd,briefPath,levelArg]=process.argv.slice(2);
  if(cmd!=="run"||!briefPath)throw new Error("Usage: node jarvis-research-runner.js run <brief-json-path> [verifier|scout|dual|heavy]");
  const brief=JSON.parse(fs.readFileSync(briefPath,"utf8"));
  const result=await runResearchBrief({brief,level:levelArg||brief.research_level||"dual"});
  process.stdout.write(JSON.stringify(result,null,2)+"\n");
  if(!result.summary.pass)process.exitCode=2;
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname)){
  cli().catch(err=>{process.stderr.write("[jarvis-research-runner] "+String(err?.message||err)+"\n");process.exit(1);});
}
