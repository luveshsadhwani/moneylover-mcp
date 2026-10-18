// Money Lover read-only MCP bridge for Cloudflare Workers.
// No account credentials or Money Lover tokens are accepted as MCP tool arguments.
const BASE = 'https://web.moneylover.me/api';
const TOKEN = 'https://oauth.moneylover.me/token';
const TOOL_DEFS = [
  { name:'get_wallets', description:'List Money Lover wallets (read only).', inputSchema:{type:'object',properties:{},additionalProperties:false}},
  { name:'get_categories', description:'List categories in one wallet (read only).', inputSchema:{type:'object',properties:{walletId:{type:'string',minLength:1}},required:['walletId'],additionalProperties:false}},
  { name:'get_transactions', description:'Read transactions from one wallet in a date range of up to 93 days (read only).', inputSchema:{type:'object',properties:{walletId:{type:'string',minLength:1},startDate:{type:'string',format:'date'},endDate:{type:'string',format:'date'}},required:['walletId','startDate','endDate'],additionalProperties:false}}
];
const reply = (obj, status=200, extra={}) => new Response(JSON.stringify(obj),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...extra}});
const rpcError=(id,code,message)=>({jsonrpc:'2.0',id,error:{code,message}});
const rpcResult=(id,result)=>({jsonrpc:'2.0',id,result});
const isDate=(s)=> typeof s==='string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s+'T00:00:00Z')) && new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
const safeId=x=>typeof x==='string' && x.length>=1 && x.length<=256;
// Diagnostics contain only fixed stage/reason labels and numeric HTTP status.
// Never include upstream bodies, URLs, headers, credentials or exception messages.
class UpstreamError extends Error {
 constructor(stage, reason, status=null) {
  super(`${stage}: ${reason}${status===null?'':` (HTTP ${status})`}`);
  this.stage=stage;this.reason=reason;this.status=status;
 }
}
async function upstreamJson(stage,url,options) {
 let response;
 try { response=await fetch(url,options); }
 catch { throw new UpstreamError(stage,'network_error'); }
 if(response.status>=300 && response.status<400)throw new UpstreamError(stage,'redirect_rejected',response.status);
 if(!response.ok)throw new UpstreamError(stage,'http_error',response.status);
 let data;
 try { data=await response.json(); }
 catch { throw new UpstreamError(stage,'invalid_json',response.status); }
 if(data?.error || data?.e)throw new UpstreamError(stage,'api_error',response.status);
 return {data,status:response.status};
}
async function getToken(env){
 const start=await upstreamJson('login-url',`${BASE}/user/login-url`,{method:'POST',redirect:'manual'});
 const requestToken=start.data?.data?.request_token,loginUrl=start.data?.data?.login_url;
 if(typeof requestToken!=='string'||typeof loginUrl!=='string')throw new UpstreamError('login-url','missing_login_fields',start.status);
 let u;
 try { u=new URL(loginUrl); } catch { throw new UpstreamError('login-url','invalid_login_url',start.status); }
 if(u.protocol!=='https:' || !u.hostname.endsWith('.moneylover.me'))throw new UpstreamError('login-url','unexpected_login_host',start.status);
 const client=u.searchParams.get('client');if(!client)throw new UpstreamError('login-url','missing_client',start.status);
 const body=new URLSearchParams({email:env.MONEYLOVER_EMAIL,password:env.MONEYLOVER_PASSWORD});
 const v=await upstreamJson('token',TOKEN,{method:'POST',headers:{Authorization:`Bearer ${requestToken}`,Client:client,'content-type':'application/x-www-form-urlencoded'},body:body.toString(),redirect:'manual'});
 if(typeof v.data?.access_token!=='string')throw new UpstreamError('token','missing_access_token',v.status);
 return v.data.access_token;
}
async function query(env,route,payload,form=false){
 const token=await getToken(env);
 const stage={'/wallet/list':'wallet/list','/category/list':'category/list','/transaction/list':'transaction/list'}[route];
 const res=await upstreamJson(stage,`${BASE}${route}`,{method:'POST',headers:{Authorization:`AuthJWT ${token}`,'content-type':form?'application/x-www-form-urlencoded':'application/json','cache-control':'no-store'},body:form?new URLSearchParams(payload).toString():JSON.stringify(payload),redirect:'manual'});
 return res.data?.data??null;
}
async function allowed(req,env){
 const incoming=req.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
 if(!incoming || !env.MCP_ACCESS_TOKEN)return false;
 const enc=new TextEncoder();const [a,b]=await Promise.all([crypto.subtle.digest('SHA-256',enc.encode(incoming)),crypto.subtle.digest('SHA-256',enc.encode(env.MCP_ACCESS_TOKEN))]);
 const x=new Uint8Array(a),y=new Uint8Array(b);let diff=0;for(let i=0;i<x.length;i++)diff|=x[i]^y[i];return diff===0;
}

async function invokeTool(name,args,env){
 if(name==='get_wallets')return {wallets:(await query(env,'/wallet/list',{}))??[]};
 if(name==='get_categories'){
  if(!safeId(args.walletId))throw Error('walletId is required');
  return {categories:(await query(env,'/category/list',{walletId:args.walletId},true))??[]};
 }
 if(name==='get_transactions'){
  if(!safeId(args.walletId)||!isDate(args.startDate)||!isDate(args.endDate))throw Error('Invalid walletId or dates');
  const days=(Date.parse(args.endDate+'T00:00:00Z')-Date.parse(args.startDate+'T00:00:00Z'))/86400000;
  if(days<0||days>93)throw Error('Date range must be 0 to 93 days');
  return {transactions:(await query(env,'/transaction/list',{walletId:args.walletId,startDate:args.startDate,endDate:args.endDate}))??[]};
 }
 throw Error('Unknown tool');
}
export default { async fetch(req,env,ctx){
 try{
  const u=new URL(req.url);if(u.pathname!=='/mcp')return reply({error:'Not found'},404);
  if(!env.MONEYLOVER_EMAIL || !env.MONEYLOVER_PASSWORD)return reply({error:'Integration not configured'},503);
  // ctx.access is authenticated and provided by the Cloudflare Workers runtime.
  // Never trust an Access JWT or audience value supplied directly in request headers.
  if(env.ACCESS_TEAM_DOMAIN || env.ACCESS_AUD){
   if(!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD){
    console.warn('moneylover_auth: access_configuration_incomplete');
    return reply({error:'Access configuration incomplete'},503);
   }
   if(!ctx?.access){
    console.warn('moneylover_auth: missing_trusted_access_context');
    return reply({error:'Unauthorized'},401,{'www-authenticate':'Bearer'});
   }
   if(ctx.access.aud !== env.ACCESS_AUD){
    console.warn('moneylover_auth: access_context_audience_mismatch');
    return reply({error:'Unauthorized'},401,{'www-authenticate':'Bearer'});
   }
  } else {
   if(!env.MCP_ACCESS_TOKEN)return reply({error:'Authentication not configured'},503);
   if(!(await allowed(req,env)))return reply({error:'Unauthorized'},401,{'www-authenticate':'Bearer'});
  }
  if(req.method==='GET')return new Response(null,{status:405,headers:{allow:'POST','cache-control':'no-store'}});
  if(req.method!=='POST')return reply({error:'Method not allowed'},405,{allow:'POST'});
  const origin=req.headers.get('origin');if(origin && new URL(origin).origin!==u.origin)return reply({error:'Origin not allowed'},403);
  if(!req.headers.get('content-type')?.startsWith('application/json'))return reply({error:'JSON required'},415);
  let payload;try{payload=await req.json()}catch{return reply(rpcError(null,-32700,'Parse error'),400)}
  if(!payload || payload.jsonrpc!=='2.0'|| typeof payload.method!=='string')return reply(rpcError(payload?.id??null,-32600,'Invalid request'),400);
  if(payload.method==='notifications/initialized')return new Response(null,{status:202});
  const id=payload.id??null;
  if(payload.method==='initialize')return reply(rpcResult(id,{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'moneylover-readonly-cloudflare',version:'0.1.0'}}));
  if(payload.method==='ping')return reply(rpcResult(id,{}));
  if(payload.method==='tools/list')return reply(rpcResult(id,{tools:TOOL_DEFS}));
  if(payload.method==='tools/call'){
   const name=payload.params?.name,args=payload.params?.arguments??{};
   if(!TOOL_DEFS.some(t=>t.name===name))return reply(rpcError(id,-32602,'Unknown tool'),400);
   try{const data=await invokeTool(name,args,env);return reply(rpcResult(id,{content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data}));}
   catch(e){if(e instanceof UpstreamError)console.warn(JSON.stringify({event:'moneylover_upstream_error',stage:e.stage,reason:e.reason,status:e.status}));return reply(rpcResult(id,{content:[{type:'text',text:'Unable to retrieve data: '+(e instanceof UpstreamError?e.message:e.message==='Invalid walletId or dates'||e.message.startsWith('Date range')||e.message==='walletId is required'?e.message:'upstream request failed')}],isError:true}));}
  }
  return reply(rpcError(id,-32601,'Method not found'),404);
 }catch{return reply({error:'Request failed'},500)}
 }};
