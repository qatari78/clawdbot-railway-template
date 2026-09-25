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
async function callResearch({apiKey,model,researcher,brief,searchEngine,level}){
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
    temperature:0.1
  };
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),level==="heavy"?20*60*1000:10*60*1000);
  let res;
  try{
    res=await fetch("https://openrouter.ai/api/v1/chat/completions",{
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
  }finally{clearTimeout(timer);}
  let data=null;try{data=await res.json();}catch{}
  if(!res.ok)throw new Error(`${researcher} OpenRouter request failed: ${data?.error?.message||data?.message||("HTTP "+res.status)}`);
  const message=data?.choices?.[0]?.message;
  const packet=extractPacket(assistantText(message));
  if(packet.brief_id!==brief.brief_id)throw new Error(researcher+" returned wrong brief_id");
  if(packet.researcher!==researcher)throw new Error(researcher+" returned wrong researcher role");
  const d=data?.usage?.server_tool_use_details||data?.usage?.server_tool_use||{};
  const searchRequests=Number(d.web_search_requests||0);
  const toolCallsRequested=Number(d.tool_calls_requested||0);
  const toolCallsExecuted=Number(d.tool_calls_executed||0);
  const annotationCount=Array.isArray(message?.annotations)?message.annotations.length:0;
  if(searchRequests<1&&annotationCount<1)throw new Error(researcher+" completed without observable web research");
  if(!Array.isArray(packet.sources)||packet.sources.length<1)throw new Error(researcher+" returned no sources");
  return{
    packet,
    telemetry:{
      researcher,model:data?.model||modelSlug(model),provider:data?.provider??null,search_engine:searchEngine,
      search_requests:searchRequests,tool_calls_requested:toolCallsRequested,tool_calls_executed:toolCallsExecuted,
      annotation_count:annotationCount,usage:data?.usage??null
    }
  };
}
export async function runResearchBrief({brief,level="dual"}){
  if(!["verifier","dual","heavy"].includes(level))throw new Error("level must be verifier, dual, or heavy");
  const p=researchPaths();
  const runId=uuidv7();
  const normalized={...brief};
  normalized.brief_id ||= "research-"+runId;
  normalized.commissioned_at ||= new Date().toISOString();
  normalized.schema="jarvis-research-brief-v1.1";
  writeResearchBrief(normalized);

  const auth=await resolveOpenRouterKeyForRuntime({stateDir:stateDir(),configPath:configPath()});
  if(!auth.key)throw new Error("OpenRouter credential could not be resolved from canonical runtime auth stores");

  const verifierModel=process.env.JARVIS_RESEARCH_VERIFIER_MODEL?.trim()||"openrouter/openai/gpt-6-sol";
  const scoutModel=process.env.JARVIS_RESEARCH_SCOUT_MODEL?.trim()||"openrouter/deepseek/deepseek-v4-flash-0731";
  const verifierSearchEngine=process.env.JARVIS_RESEARCH_VERIFIER_SEARCH_ENGINE?.trim()||"native";
  const scoutSearchEngine=process.env.JARVIS_RESEARCH_SCOUT_SEARCH_ENGINE?.trim()||"perplexity";

  const jobs=[callResearch({apiKey:auth.key,model:verifierModel,researcher:"verifier",brief:normalized,searchEngine:verifierSearchEngine,level})];
  if(level!=="verifier")jobs.push(callResearch({apiKey:auth.key,model:scoutModel,researcher:"scout",brief:normalized,searchEngine:scoutSearchEngine,level}));
  const settled=await Promise.allSettled(jobs);
  const failures=[],telemetry=[],packets=[];
  for(const item of settled){
    if(item.status==="rejected"){failures.push(String(item.reason?.message||item.reason));continue;}
    const x=item.value;
    const ingested=ingestResearchPacket(x.packet);
    packets.push(ingested.packet_id);
    telemetry.push(x.telemetry);
  }
  const pass=failures.length===0&&packets.length===jobs.length;
  let merge=null,verification=null,dossier=null;
  if(pass){
    merge=mergeResearchBrief(normalized.brief_id);
    verification=await verifyResearchSources(normalized.brief_id);
    dossier=buildResearchDossier(normalized.brief_id);
  }
  const totalCost=telemetry.reduce((s,x)=>s+Number(x.usage?.cost||0),0);
  const summary={
    schema:"jarvis-research-run-v1.1",run_id:runId,brief_id:normalized.brief_id,level,
    started_at:normalized.commissioned_at,finished_at:new Date().toISOString(),pass,failures,
    packets,telemetry,total_cost_usd:totalCost,
    merge:merge?{merge_id:merge.merge_id,source_count:merge.source_count,claim_count:merge.claim_count,contradiction_count:merge.contradiction_count}:null,
    verification:verification?{verification_id:verification.verification_id,reachable_sources:verification.reachable_sources,unreachable_sources:verification.unreachable_sources,numeric_mismatches:verification.numeric_mismatches,source_failures:verification.source_failures}:null,
    dossier:dossier?{dossier_id:dossier.dossier_id,path:dossier.path}:null
  };
  const runPath=path.join(p.runs,runId+".json");
  fs.writeFileSync(runPath,JSON.stringify(summary,null,2)+"\n",{encoding:"utf8",mode:0o600});
  appendEvent("research-run-completed",{run_id:runId,brief_id:normalized.brief_id,level,pass,total_cost_usd:totalCost});
  return{summary,dossier};
}
async function cli(){
  const [cmd,briefPath,levelArg]=process.argv.slice(2);
  if(cmd!=="run"||!briefPath)throw new Error("Usage: node jarvis-research-runner.js run <brief-json-path> [verifier|dual|heavy]");
  const brief=JSON.parse(fs.readFileSync(briefPath,"utf8"));
  const result=await runResearchBrief({brief,level:levelArg||brief.research_level||"dual"});
  process.stdout.write(JSON.stringify(result,null,2)+"\n");
  if(!result.summary.pass)process.exitCode=2;
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname)){
  cli().catch(err=>{process.stderr.write("[jarvis-research-runner] "+String(err?.message||err)+"\n");process.exit(1);});
}
