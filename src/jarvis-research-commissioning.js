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

const START="JARVIS_PACKET_START";
const END="JARVIS_PACKET_END";

function stateDir() {
  return process.env.OPENCLAW_STATE_DIR?.trim() || "/data/.openclaw";
}
function configPath() {
  return process.env.OPENCLAW_CONFIG_PATH?.trim() || path.join(stateDir(),"openclaw.json");
}
function modelSlug(value) {
  return String(value || "").replace(/^openrouter\//,"");
}
function collectStrings(value,out=[]){
  if(typeof value==="string")out.push(value);
  else if(Array.isArray(value))for(const x of value)collectStrings(x,out);
  else if(value&&typeof value==="object")for(const x of Object.values(value))collectStrings(x,out);
  return out;
}
function assistantText(message){
  const content=message?.content;
  if(typeof content==="string")return content;
  if(Array.isArray(content))return content.map(x=>typeof x==="string"?x:(x?.text||x?.content||"")).join("\n");
  return String(content||"");
}
function extractPacket(text){
  const candidates=[String(text||"")];
  try{candidates.unshift(...collectStrings(JSON.parse(String(text||""))));}catch{}
  for(const value of candidates){
    const a=value.indexOf(START), b=value.indexOf(END,a+START.length);
    if(a>=0&&b>a){
      const body=value.slice(a+START.length,b).trim().replace(/^```(?:json)?/i,"").replace(/```$/,"").trim();
      return JSON.parse(body);
    }
    const trimmed=value.trim().replace(/^```(?:json)?/i,"").replace(/```$/,"").trim();
    if(trimmed.startsWith("{")&&trimmed.endsWith("}")){
      try{
        const packet=JSON.parse(trimmed);
        if(packet?.brief_id&&packet?.researcher)return packet;
      }catch{}
    }
  }
  throw new Error("No valid research packet found in model response");
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
      "Do not use prior conclusions, personal memory, another researcher's work, or adviser views.",
    ].join("\n");
  }
  return [
    "You are Jarvis Scout, an independent landscape, adversarial and enumeration researcher.",
    "Research facts, not advice. Map the landscape before narrowing and deliberately seek contrary evidence, corrections, failures, regulator actions, lawsuits, retractions and later revisions.",
    "Use secondary sources as leads, then open underlying primary material where available.",
    "Vary queries across synonyms, competing terminology, local names and adjacent categories.",
    "For every material claim capture a source URL and a precise locator. Keep direct quotes tiny; prefer faithful paraphrase.",
    "Record contradictions and unknowns. Do not reconcile disagreement by guessing.",
    "Do not use prior conclusions, personal memory, another researcher's work, or adviser views.",
  ].join("\n");
}

function packetContract(brief,researcher){
  return [
    "Return evidence only, no recommendation.",
    "You MUST use web search for this commission, and fetch/read important underlying pages before making material claims.",
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
        evidence:[{
          source_ref:"S1",
          type:"text",
          locator:"section/page/table/heading",
          paraphrase:"short precise supporting evidence"
        }],
        derived_from_claim_ids:[],
        formula:null
      }],
      sources:[{
        source_id:"S1",
        url:"https://example.com/source",
        title:"source title",
        publisher:"publisher",
        source_class:"primary",
        published_at:null,
        retrieved_at:new Date().toISOString(),
        origin_url:null,
        immutable:false,
        content_hash:null,
        derived_from:[]
      }],
      open_questions:[{
        question:"material remaining uncertainty",
        materiality:"medium",
        why:"why it matters"
      }]
    },null,2),
    END
  ].join("\n");
}

async function callOpenRouterResearch({apiKey,model,researcher,brief,searchEngine}){
  const requestBody={
    model:modelSlug(model),
    messages:[
      {role:"system",content:roleSystem(researcher)},
      {role:"user",content:[
        "PRIMARY RESEARCH COMMISSION — fresh isolated request.",
        "Another researcher receives the same neutral brief independently. Do not seek or infer their work.",
        "",
        "NEUTRAL BRIEF",
        JSON.stringify(brief,null,2),
        "",
        packetContract(brief,researcher),
      ].join("\n")}
    ],
    reasoning:{effort:"high"},
    tools:[
      {
        type:"openrouter:web_search",
        parameters:{
          engine:searchEngine,
          max_results:8,
          max_total_results:32,
          search_context_size:"medium"
        }
      },
      {
        type:"openrouter:web_fetch",
        parameters:{
          engine:"openrouter",
          max_content_tokens:30000
        }
      }
    ],
    max_tool_calls:12,
    temperature:0.1
  };

  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),8*60*1000);
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
  } finally {
    clearTimeout(timer);
  }

  let data=null;
  try{data=await res.json();}catch{}
  if(!res.ok){
    const detail=data?.error?.message||data?.message||("HTTP "+res.status);
    throw new Error(`${researcher} OpenRouter request failed: ${detail}`);
  }
  const message=data?.choices?.[0]?.message;
  const text=assistantText(message);
  const packet=extractPacket(text);
  if(packet.brief_id!==brief.brief_id)throw new Error(researcher+" returned wrong brief_id");
  if(packet.researcher!==researcher)throw new Error(researcher+" returned wrong researcher role");

  const searchRequests=Number(data?.usage?.server_tool_use?.web_search_requests ?? 0);
  if(searchRequests<1)throw new Error(researcher+" completed without a web_search server-tool call");

  return {
    packet,
    usage:data?.usage??null,
    annotations:message?.annotations??null,
    model:data?.model??modelSlug(model),
    provider:data?.provider??null,
    search_engine:searchEngine,
    search_requests:searchRequests
  };
}

export async function runJarvisResearchCommissioningV1(){
  if(process.env.JARVIS_RESEARCH_COMMISSION_V1?.trim()!=="1")return{ran:false,reason:"disabled"};

  const p=researchPaths();
  const resultPath=path.join(p.diagnostics,"commission-v1.2-openrouter-server-tools.json");
  if(fs.existsSync(resultPath)){
    try{
      const old=JSON.parse(fs.readFileSync(resultPath,"utf8"));
      if(old?.pass===true){
        console.log("[research-commission-v1] prior passing result exists; skipping");
        return{ran:false,reason:"already-passed",resultPath};
      }
    }catch{}
  }

  const brief={
    brief_id:"commission-openrouter-server-tools-v1",
    question:"Determine from current public evidence how OpenRouter server-side web search and web fetch work for hosted agentic research: request/tool mechanism, model-controlled multi-step behavior, source/citation return, supported engines/provider behavior, pricing or metering, and material integration constraints.",
    jurisdiction:"global/public product documentation",
    period:"current as of commissioning date",
    definitions:"Distinguish OpenRouter server tools from the deprecated web plugin, model-provider native search, and client-side browser automation.",
    comparison_scope:"Official OpenRouter documentation first; independent technical sources may be used to discover caveats or contradictions.",
    stakes:"architecture commissioning only",
    freshness:"current",
    commissioned_at:new Date().toISOString(),
    exclusions:["No recommendation about Jarvis model selection.","No private/authenticated web pages.","No prior adviser conclusions."]
  };
  writeResearchBrief(brief);

  const auth=await resolveOpenRouterKeyForRuntime({stateDir:stateDir(),configPath:configPath()});
  if(!auth.key){
    const summary={
      version:"v1.2",startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),
      brief_id:brief.brief_id,pass:false,error:"OpenRouter credential could not be resolved from canonical runtime auth stores.",
      auth_attempts:auth.attempts
    };
    fs.mkdirSync(path.dirname(resultPath),{recursive:true,mode:0o700});
    fs.writeFileSync(resultPath,JSON.stringify(summary,null,2)+"\n",{encoding:"utf8",mode:0o600});
    console.log("[research-commission-v1] completed "+JSON.stringify(summary));
    return{ran:true,resultPath,pass:false};
  }

  const verifierModel=process.env.JARVIS_RESEARCH_VERIFIER_MODEL?.trim()||"openrouter/openai/gpt-6-sol";
  const scoutModel=process.env.JARVIS_RESEARCH_SCOUT_MODEL?.trim()||"openrouter/deepseek/deepseek-v4-flash-0731";
  const startedAt=new Date().toISOString();
  const runId=uuidv7();

  let results=[],error=null;
  try{
    const calls=await Promise.all([
      callOpenRouterResearch({
        apiKey:auth.key,model:verifierModel,researcher:"verifier",brief,searchEngine:"native"
      }),
      callOpenRouterResearch({
        apiKey:auth.key,model:scoutModel,researcher:"scout",brief,searchEngine:"exa"
      })
    ]);
    for(const x of calls){
      const ingested=ingestResearchPacket(x.packet);
      results.push({
        researcher:x.packet.researcher,
        packet_id:ingested.packet_id,
        model:x.model,
        provider:x.provider,
        search_engine:x.search_engine,
        search_requests:x.search_requests,
        usage:x.usage
      });
    }
  }catch(err){
    error=String(err?.message||err);
  }

  let merge=null,dossier=null;
  if(!error){
    merge=mergeResearchBrief(brief.brief_id);
    dossier=buildResearchDossier(brief.brief_id);
  }

  const summary={
    version:"v1.2",startedAt,finishedAt:new Date().toISOString(),brief_id:brief.brief_id,run_id:runId,
    pass:!error&&results.length===2,
    researchers:results,
    error,
    auth_source:auth.source,
    auth_agent_id:auth.agentId,
    auth_profile_id:auth.profileId,
    merge:error?null:{
      merge_id:merge.merge_id,
      source_count:merge.source_count,
      claim_count:merge.claim_count,
      contradiction_count:merge.contradiction_count
    },
    dossier:error?null:{dossier_id:dossier.dossier_id,path:dossier.path}
  };
  fs.mkdirSync(path.dirname(resultPath),{recursive:true,mode:0o700});
  fs.writeFileSync(resultPath,JSON.stringify(summary,null,2)+"\n",{encoding:"utf8",mode:0o600});
  appendEvent("commissioning-completed",{
    brief_id:brief.brief_id,pass:summary.pass,error:summary.error,run_id:runId,
    researchers:results.map(r=>({researcher:r.researcher,model:r.model,search_engine:r.search_engine,search_requests:r.search_requests}))
  });
  console.log("[research-commission-v1] completed "+JSON.stringify(summary));
  return{ran:true,resultPath,pass:summary.pass};
}
