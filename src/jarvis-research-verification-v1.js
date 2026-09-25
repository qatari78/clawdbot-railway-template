import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";
import { appendEvent, canonicalUrl, researchPaths, uuidv7 } from "./jarvis-research-system-v1.js";

const MAX_BYTES=4*1024*1024;
const FETCH_TIMEOUT_MS=20_000;

function ensureDir(p){fs.mkdirSync(p,{recursive:true,mode:0o700});try{fs.chmodSync(p,0o700);}catch{}}
function atomicWrite(p,body,encoding=null){
  ensureDir(path.dirname(p));
  const t=p+".tmp-"+process.pid+"-"+Date.now();
  if(encoding)fs.writeFileSync(t,body,{encoding,mode:0o600});else fs.writeFileSync(t,body,{mode:0o600});
  fs.renameSync(t,p);
}
function sha256(v){return crypto.createHash("sha256").update(v).digest("hex");}
function privateIp(ip){
  const s=String(ip||"").toLowerCase();
  if(s==="::1"||s==="0.0.0.0"||s==="127.0.0.1")return true;
  if(/^127\./.test(s)||/^10\./.test(s)||/^192\.168\./.test(s)||/^169\.254\./.test(s))return true;
  const m=s.match(/^172\.(\d+)\./); if(m&&Number(m[1])>=16&&Number(m[1])<=31)return true;
  if(s.startsWith("fc")||s.startsWith("fd")||s.startsWith("fe80:"))return true;
  return false;
}
async function assertSafeUrl(raw){
  const u=new URL(raw);
  if(!["http:","https:"].includes(u.protocol))throw new Error("unsupported protocol");
  if(["localhost","localhost.localdomain"].includes(u.hostname.toLowerCase()))throw new Error("localhost blocked");
  const answers=await dns.lookup(u.hostname,{all:true,verbatim:true});
  if(!answers.length)throw new Error("dns lookup returned no addresses");
  if(answers.some(a=>privateIp(a.address)))throw new Error("private/link-local destination blocked");
  return u;
}
function decodeEntities(s){
  return s.replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&lt;/gi,"<").replace(/&gt;/gi,">")
    .replace(/&quot;/gi,'"').replace(/&#39;/gi,"'");
}
function htmlToText(html){
  return decodeEntities(String(html||"")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi," ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi," ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi," ")
    .replace(/<[^>]+>/g," ")
    .replace(/\s+/g," ")).trim();
}
function arabicDigitsToLatin(s){
  const a="٠١٢٣٤٥٦٧٨٩", p="۰۱۲۳۴۵۶۷۸۹";
  return String(s).replace(/[٠-٩]/g,c=>String(a.indexOf(c))).replace(/[۰-۹]/g,c=>String(p.indexOf(c)));
}
function numericTokens(s){
  const t=arabicDigitsToLatin(s).replace(/[٬،]/g,",").replace(/[٫]/g,".");
  return Array.from(t.matchAll(/(?:[$€£¥]|QAR|USD|EUR|GBP|SAR|AED)?\s*-?\d[\d,]*(?:\.\d+)?%?/gi)).map(m=>m[0].replace(/\s+/g,"").toLowerCase());
}
function normalizeNumberToken(s){
  return String(s).toLowerCase().replace(/qar|usd|eur|gbp|sar|aed|[$€£¥%]/g,"").replace(/,/g,"").trim();
}

async function fetchOne(source){
  const url=canonicalUrl(source.url);
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),FETCH_TIMEOUT_MS);
  try{
    await assertSafeUrl(url);
    const res=await fetch(url,{redirect:"follow",signal:controller.signal,headers:{
      "User-Agent":"JarvisResearchVerifier/1.1 (+read-only evidence verification)",
      "Accept":"text/html,application/xhtml+xml,application/json,text/plain,application/pdf,*/*;q=0.5"
    }});
    const reader=res.body?.getReader();
    const chunks=[]; let total=0;
    if(reader){
      while(true){
        const {done,value}=await reader.read(); if(done)break;
        total+=value.byteLength; if(total>MAX_BYTES){try{await reader.cancel();}catch{};throw new Error("source exceeds 4 MiB verification cap");}
        chunks.push(Buffer.from(value));
      }
    }
    const body=Buffer.concat(chunks);
    const type=String(res.headers.get("content-type")||"").toLowerCase();
    const hash=sha256(body);
    let text=null;
    if(type.includes("text/")||type.includes("json")||type.includes("xml")||type.includes("html")){
      const decoded=body.toString("utf8");
      text=type.includes("html")?htmlToText(decoded):decoded;
    }
    return{ok:res.ok,http_status:res.status,final_url:canonicalUrl(res.url||url),content_type:type,bytes:body.length,content_hash:hash,raw:body,text,error:null};
  }catch(err){
    return{ok:false,http_status:null,final_url:url,content_type:null,bytes:0,content_hash:null,raw:null,text:null,error:String(err?.message||err)};
  }finally{clearTimeout(timer);}
}

export async function verifyResearchSources(briefId){
  const p=researchPaths();
  const mergePath=path.join(p.merges,briefId+".json");
  const merge=JSON.parse(fs.readFileSync(mergePath,"utf8"));
  const verificationDir=path.join(p.root,"ledger","verifications");
  ensureDir(verificationDir); ensureDir(p.docs);

  const sourceResults={};
  for(const s of merge.sources||[]){
    const result=await fetchOne(s);
    const meta={
      source_key:s.source_key,url:s.url,canonical_origin:s.canonical_origin??null,
      fetched_at:new Date().toISOString(),ok:result.ok,http_status:result.http_status,final_url:result.final_url,
      content_type:result.content_type,bytes:result.bytes,content_hash:result.content_hash,error:result.error
    };
    if(result.raw&&result.content_hash){
      const rawPath=path.join(p.docs,result.content_hash+".bin");
      if(!fs.existsSync(rawPath))atomicWrite(rawPath,result.raw);
      if(result.text){
        const textPath=path.join(p.docs,result.content_hash+".txt");
        if(!fs.existsSync(textPath))atomicWrite(textPath,result.text,"utf8");
        meta.text_cache_path=textPath;
      }
      meta.raw_cache_path=rawPath;
    }
    sourceResults[s.source_key]={...meta,_text:result.text};
  }

  const claims=[];
  for(const c of merge.claims||[]){
    const keys=Array.isArray(c.evidence_chains)?c.evidence_chains:[];
    const fetched=keys.map(k=>sourceResults[k]).filter(Boolean);
    const reachable=fetched.filter(x=>x.ok);
    const nums=numericTokens(c.statement||"");
    let numeric_status="not_applicable";
    let missing_numbers=[];
    if(c.basis==="direct"&&nums.length){
      numeric_status="pass";
      const corpus=arabicDigitsToLatin(reachable.map(x=>x._text||"").join("\n")).replace(/[٬،]/g,",").replace(/[٫]/g,".");
      missing_numbers=nums.filter(n=>{
        const target=normalizeNumberToken(n);
        if(!target)return false;
        const variants=new Set([target,target.replace(/\.0+$/,"")]);
        for(const token of numericTokens(corpus)){
          if(variants.has(normalizeNumberToken(token)))return false;
        }
        return true;
      });
      if(missing_numbers.length)numeric_status=reachable.length?"mismatch":"unverifiable";
    }
    let mechanical_status="unverified";
    if(!keys.length)mechanical_status="no_evidence_chain";
    else if(!reachable.length)mechanical_status="source_unreachable";
    else if(numeric_status==="mismatch")mechanical_status="numeric_mismatch";
    else mechanical_status="source_reachable";
    claims.push({
      merged_claim_id:c.merged_claim_id,statement:c.statement,materiality:c.materiality,basis:c.basis,
      evidence_chains:keys,reachable_source_count:reachable.length,
      mechanical_status,numeric_status,missing_numbers
    });
  }

  const publicSources=Object.fromEntries(Object.entries(sourceResults).map(([k,v])=>[k,Object.fromEntries(Object.entries(v).filter(([name])=>name!=="_text"))]));
  const summary={
    schema:"jarvis-research-source-verification-v1.1",verification_id:uuidv7(),brief_id:briefId,
    generated_at:new Date().toISOString(),source_count:Object.keys(publicSources).length,
    reachable_sources:Object.values(publicSources).filter(x=>x.ok).length,
    unreachable_sources:Object.values(publicSources).filter(x=>!x.ok).length,
    claims_checked:claims.length,
    numeric_mismatches:claims.filter(x=>x.mechanical_status==="numeric_mismatch").length,
    source_failures:claims.filter(x=>x.mechanical_status==="source_unreachable").length,
    sources:publicSources,claims,
    note:"Mechanical source reachability/content-hash and direct-number checks only. Semantic entailment remains a separate verification step."
  };
  const dst=path.join(verificationDir,briefId+".json"); atomicWrite(dst,JSON.stringify(summary,null,2)+"\n","utf8");
  appendEvent("source-verification-completed",{brief_id:briefId,verification_id:summary.verification_id,reachable_sources:summary.reachable_sources,unreachable_sources:summary.unreachable_sources,numeric_mismatches:summary.numeric_mismatches});
  return{...summary,path:dst};
}
