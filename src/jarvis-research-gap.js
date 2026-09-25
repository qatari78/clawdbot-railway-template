import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { appendEvent, researchPaths, uuidv7 } from "./jarvis-research-system-v1.js";
import { runResearchBrief } from "./jarvis-research-runner.js";

function ensureDir(p){fs.mkdirSync(p,{recursive:true,mode:0o700});try{fs.chmodSync(p,0o700);}catch{}}
function atomicWrite(p,body){ensureDir(path.dirname(p));const t=p+".tmp-"+process.pid+"-"+Date.now();fs.writeFileSync(t,body,{encoding:"utf8",mode:0o600});fs.renameSync(t,p);}
function readJson(p){return JSON.parse(fs.readFileSync(p,"utf8"));}
function hash(v){return crypto.createHash("sha256").update(String(v)).digest("hex");}
function route(type){
  if(["verify","read_document"].includes(type))return"verifier";
  if(["find_missing","find_contrary","enumerate"].includes(type))return"scout";
  if(type==="social")throw new Error("social gaps must use the dedicated X helper, not the web research gap service");
  if(type==="calculate")throw new Error("calculate gaps must use deterministic computation from verified ledger inputs");
  throw new Error("unsupported gap type: "+type);
}
function safeInheritance(parent){
  return{
    jurisdiction:parent.jurisdiction??null,
    period:parent.period??null,
    definitions:parent.definitions??null,
    comparison_scope:parent.comparison_scope??null,
    stakes:parent.stakes??null,
    freshness:parent.freshness??null
  };
}
export async function requestEvidenceGap(req){
  if(!req?.parent_brief_id||!req?.type||!req?.question)throw new Error("parent_brief_id, type, and question are required");
  if(req.deidentified!==true)throw new Error("gap request must be explicitly marked deidentified=true before external research");
  const p=researchPaths();
  const parentPath=path.join(p.briefs,req.parent_brief_id+".json");
  if(!fs.existsSync(parentPath))throw new Error("parent brief not found: "+req.parent_brief_id);
  const parent=readJson(parentPath);
  const gapsDir=path.join(p.root,"gaps");
  const deltasDir=path.join(p.dossiers,"deltas",req.parent_brief_id);
  ensureDir(gapsDir);ensureDir(deltasDir);

  const signature=hash(JSON.stringify({
    parent_brief_id:req.parent_brief_id,type:req.type,question:String(req.question).trim().toLowerCase(),
    requested_by:req.requested_by||null
  })).slice(0,24);
  const dedupePath=path.join(gapsDir,"by-signature-"+signature+".json");
  if(fs.existsSync(dedupePath)){
    const previous=readJson(dedupePath);
    if(previous?.status==="completed")return{...previous,deduped:true};
  }

  const gapId=req.gap_id||"gap-"+uuidv7();
  const level=route(req.type);
  const beforeDossierPath=path.join(p.dossiers,req.parent_brief_id+".json");
  let beforePackets=[];
  try{beforePackets=readJson(beforeDossierPath).packet_ids||[];}catch{}
  const taskBrief={
    brief_id:gapId,
    parent_brief_id:req.parent_brief_id,
    research_kind:"evidence_gap",
    gap_type:req.type,
    question:req.question,
    rationale:req.rationale??null,
    requested_by:req.requested_by??null,
    materiality:req.materiality??"medium",
    ...safeInheritance(parent),
    commissioned_at:new Date().toISOString(),
    exclusions:[
      "Do not use prior adviser conclusions as evidence.",
      "Do not identify or reconstruct redacted private entities.",
      ...(Array.isArray(req.exclusions)?req.exclusions:[])
    ]
  };
  const record={
    schema:"jarvis-research-gap-v1.1",gap_id:gapId,signature,parent_brief_id:req.parent_brief_id,
    type:req.type,route:level,question:req.question,requested_by:req.requested_by??null,
    created_at:new Date().toISOString(),status:"running",deduped:false
  };
  atomicWrite(dedupePath,JSON.stringify(record,null,2)+"\n");
  appendEvent("evidence-gap-started",{gap_id:gapId,parent_brief_id:req.parent_brief_id,type:req.type,route:level,requested_by:req.requested_by??null});

  try{
    const result=await runResearchBrief({brief:taskBrief,level,ledgerBriefId:req.parent_brief_id});
    if(!result.summary.pass)throw new Error(result.summary.failures.join(" | ")||"gap research failed");
    const afterPackets=result.dossier?.packet_ids||[];
    const newPacketIds=afterPackets.filter(x=>!beforePackets.includes(x));
    const delta={
      schema:"jarvis-research-dossier-delta-v1.1",gap_id:gapId,parent_brief_id:req.parent_brief_id,
      generated_at:new Date().toISOString(),new_packet_ids:newPacketIds,
      run_id:result.summary.run_id,route:level,
      merge:result.summary.merge,verification:result.summary.verification,
      semantic_support:result.summary.semantic_support,
      open_questions:result.dossier?.open_questions||[],
      contradictions:result.dossier?.contradictions||[]
    };
    const deltaPath=path.join(deltasDir,gapId+".json");
    atomicWrite(deltaPath,JSON.stringify(delta,null,2)+"\n");
    const done={...record,status:"completed",finished_at:new Date().toISOString(),run_id:result.summary.run_id,new_packet_ids:newPacketIds,delta_path:deltaPath,total_cost_usd:result.summary.total_cost_usd};
    atomicWrite(dedupePath,JSON.stringify(done,null,2)+"\n");
    atomicWrite(path.join(gapsDir,gapId+".json"),JSON.stringify(done,null,2)+"\n");
    appendEvent("evidence-gap-completed",{gap_id:gapId,parent_brief_id:req.parent_brief_id,route:level,new_packet_ids:newPacketIds,total_cost_usd:result.summary.total_cost_usd});
    return done;
  }catch(err){
    const failed={...record,status:"failed",finished_at:new Date().toISOString(),error:String(err?.message||err)};
    atomicWrite(dedupePath,JSON.stringify(failed,null,2)+"\n");
    atomicWrite(path.join(gapsDir,gapId+".json"),JSON.stringify(failed,null,2)+"\n");
    appendEvent("evidence-gap-failed",{gap_id:gapId,parent_brief_id:req.parent_brief_id,route:level,error:failed.error});
    throw err;
  }
}
async function cli(){
  const requestPath=process.argv[2];
  if(!requestPath)throw new Error("Usage: node jarvis-research-gap.js <gap-request-json-path>");
  const r=await requestEvidenceGap(readJson(requestPath));
  process.stdout.write(JSON.stringify(r,null,2)+"\n");
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname)){
  cli().catch(err=>{process.stderr.write("[jarvis-research-gap] "+String(err?.message||err)+"\n");process.exit(1);});
}
