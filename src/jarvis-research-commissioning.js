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

const START="JARVIS_PACKET_START";
const END="JARVIS_PACKET_END";

function collectStrings(value,out=[]){
  if(typeof value==="string")out.push(value);
  else if(Array.isArray(value))for(const x of value)collectStrings(x,out);
  else if(value&&typeof value==="object")for(const x of Object.values(value))collectStrings(x,out);
  return out;
}

function extractPacket(output){
  const candidates=[String(output||"")];
  try{candidates.unshift(...collectStrings(JSON.parse(String(output||""))));}catch{}
  for(const text of candidates){
    const a=text.indexOf(START), b=text.indexOf(END,a+START.length);
    if(a>=0&&b>a){
      const body=text.slice(a+START.length,b).trim().replace(/^```(?:json)?/i,"").replace(/```$/,"").trim();
      return JSON.parse(body);
    }
  }
  throw new Error("No research packet sentinel found in agent output");
}

function promptFor(brief,researcher){
  return [
    "PRIMARY RESEARCH COMMISSION — fresh isolated task.",
    "Do not use prior task conclusions or personal memory. Another researcher is independently receiving the same neutral brief; do not seek or infer their work.",
    "Use your configured web_search, web_fetch and browser tools autonomously as needed. Search snippets are leads, not evidence. Open the underlying sources.",
    "",
    "NEUTRAL BRIEF:",
    JSON.stringify(brief,null,2),
    "",
    "Return evidence, not recommendations. Keep direct quotations tiny; prefer precise paraphrase with source locator.",
    "Every source must have a stable source_id you create, and every evidence item must reference one of those source_id values via source_ref.",
    "Use claim_topic as a short neutral proposition/topic label. polarity must be supports, refutes, mixed, or na.",
    "For derived claims include derived_from_claim_ids and formula. Do not mark a claim verified without evidence.",
    "",
    "Return ONLY the following sentinel block, with valid JSON between the sentinels:",
    START,
    JSON.stringify({
      schema:"jarvis-research-packet-v1.1",
      brief_id:brief.brief_id,
      researcher,
      memo:"<=600 words",
      claims:[{
        statement:"claim",
        claim_topic:"neutral proposition label",
        polarity:"supports",
        basis:"direct",
        materiality:"high",
        status:"verified",
        evidence:[{source_ref:"S1",type:"text",locator:"section/page/table",paraphrase:"short precise evidence"}],
        derived_from_claim_ids:[],
        formula:null
      }],
      sources:[{
        source_id:"S1",url:"https://example.com",title:"title",publisher:"publisher",source_class:"primary",
        published_at:null,retrieved_at:new Date().toISOString(),origin_url:null,immutable:false,content_hash:null,derived_from:[]
      }],
      open_questions:[{question:"remaining uncertainty",materiality:"medium",why:"why it matters"}]
    },null,2),
    END
  ].join("\n");
}

export async function runJarvisResearchCommissioningV1({workspaceDir,runCmd,clawArgs,openclawNode}){
  if(process.env.JARVIS_RESEARCH_COMMISSION_V1?.trim()!=="1")return{ran:false,reason:"disabled"};
  const p=researchPaths();
  const resultPath=path.join(p.diagnostics,"commission-v1.1-openrouter-web.json");
  if(fs.existsSync(resultPath)){
    console.log("[research-commission-v1] prior result exists; skipping");
    return{ran:false,reason:"already-ran",resultPath};
  }

  const brief={
    brief_id:"commission-openrouter-web-v1",
    question:"Determine, from current public evidence, how OpenRouter supports model-controlled web search and web retrieval: request/tool mechanism, source/citation return, supported provider/model behavior, pricing or metering, and material integration constraints for a hosted agent runtime.",
    jurisdiction:"global/public product documentation",
    period:"current as of commissioning date",
    definitions:"Distinguish OpenRouter product behavior from underlying model-provider behavior and from external browser automation.",
    comparison_scope:"Official documentation first; independent technical sources may be used to identify gaps, caveats, or contradictory behavior.",
    stakes:"architecture commissioning only",
    freshness:"current",
    commissioned_at:new Date().toISOString(),
    exclusions:["No recommendation about Jarvis model selection.","No access to private accounts or authenticated pages.","No prior adviser conclusions."]
  };
  writeResearchBrief(brief);
  const runId=uuidv7();
  const jobs=[
    {agentId:"research-01",researcher:"verifier"},
    {agentId:"research-02",researcher:"scout"},
  ];

  const startedAt=new Date().toISOString();
  const runOne=async({agentId,researcher})=>{
    const t0=Date.now();
    const sessionKey="agent:"+agentId+":research-"+runId+"-"+researcher;
    const r=await runCmd(
      openclawNode,
      clawArgs(["agent","--session-key",sessionKey,"--message",promptFor(brief,researcher),"--json"]),
      {timeoutMs:8*60*1000}
    );
    const output=String(r.output||"");
    if(r.code!==0)throw new Error(agentId+" exited "+r.code+": "+output.slice(-1200));
    const packet=extractPacket(output);
    if(packet.brief_id!==brief.brief_id)throw new Error(agentId+" returned wrong brief_id");
    if(packet.researcher!==researcher)throw new Error(agentId+" returned wrong researcher role");
    const ingested=ingestResearchPacket(packet);
    return{agentId,researcher,elapsedMs:Date.now()-t0,packet_id:ingested.packet_id};
  };

  let results=[], error=null;
  try{
    results=await Promise.all(jobs.map(runOne));
  }catch(err){
    error=String(err?.message||err);
  }

  let merge=null,dossier=null;
  if(!error){
    merge=mergeResearchBrief(brief.brief_id);
    dossier=buildResearchDossier(brief.brief_id);
  }
  const summary={
    version:"v1.1",startedAt,finishedAt:new Date().toISOString(),brief_id:brief.brief_id,run_id:runId,
    pass:!error&&results.length===2,
    researchers:results,error,
    merge:error?null:{merge_id:merge.merge_id,source_count:merge.source_count,claim_count:merge.claim_count,contradiction_count:merge.contradiction_count},
    dossier:error?null:{dossier_id:dossier.dossier_id,path:dossier.path}
  };
  fs.mkdirSync(path.dirname(resultPath),{recursive:true,mode:0o700});
  fs.writeFileSync(resultPath,JSON.stringify(summary,null,2)+"\n",{encoding:"utf8",mode:0o600});
  appendEvent("commissioning-completed",{brief_id:brief.brief_id,pass:summary.pass,error:summary.error,run_id:runId});
  console.log("[research-commission-v1] completed "+JSON.stringify(summary));
  return{ran:true,resultPath,pass:summary.pass};
}
