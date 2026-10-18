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
async function readJson(response){if(!response.ok)throw Error('Upstream request failed');const data=await response.json();if(data?.error || data?.e)throw Error('Upstream returned an error');return data;}
async function getToken(env){
 const start=await readJson(await fetch(`${BASE}/user/login-url`,{method:'POST',redirect:'error'}));
 const requestToken=start?.data?.request_token,loginUrl=start?.data?.login_url;
 if(typeof requestToken!=='string'||typeof loginUrl!=='string')throw Error('Upstream authentication unavailable');
 const u=new URL(loginUrl);if(u.protocol!=='https:' || !u.hostname.endsWith('.moneylover.me'))throw Error('Unexpected login host');
 const client=u.searchParams.get('client');if(!client)throw Error('Missing upstream client');
 const body=new URLSearchParams({email:env.MONEYLOVER_EMAIL,password:env.MONEYLOVER_PASSWORD});
 const v=await readJson(await fetch(TOKEN,{method:'POST',headers:{Authorization:`Bearer ${requestToken}`,Client:client,'content-type':'application/x-www-form-urlencoded'},body:body.toString(),redirect:'error'}));
 if(typeof v.access_token!=='string')throw Error('Upstream authentication failed');return v.access_token;
}
async function query(env,route,payload,form=false){
 const token=await getToken(env);
 const res=await readJson(await fetch(`${BASE}${route}`,{method:'POST',headers:{Authorization:`AuthJWT ${token}`,'content-type':form?'application/x-www-form-urlencoded':'application/json','cache-control':'no-store'},body:form?new URLSearchParams(payload).toString():JSON.stringify(payload),redirect:'error'}));
 return res?.data??null;
}
async function allowed(req,env){
 const incoming=req.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
 if(!incoming || !env.MCP_ACCESS_TOKEN)return false;
 const enc=new TextEncoder();const [a,b]=await Promise.all([crypto.subtle.digest('SHA-256',enc.encode(incoming)),crypto.subtle.digest('SHA-256',enc.encode(env.MCP_ACCESS_TOKEN))]);
 const x=new Uint8Array(a),y=new Uint8Array(b);let diff=0;for(let i=0;i<x.length;i++)diff|=x[i]^y[i];return diff===0;
}

function decodeBase64Url(value) {
 const raw=value.replace(/-/g,'+').replace(/_/g,'/');
 const bytes=atob(raw.padEnd(Math.ceil(raw.length/4)*4,'='));
 return Uint8Array.from(bytes,c=>c.charCodeAt(0));
}
async function validAccessJwt(req,env){
 const fail=reason=>({ok:false,reason});
 const jwt=req.headers.get('Cf-Access-Jwt-Assertion');
 if(!jwt)return fail('missing_access_jwt_header');
 if(jwt.length>12000)return fail('oversized_access_jwt');
 const parts=jwt.split('.');
 if(parts.length!==3)return fail('malformed_access_jwt');
 let phase='decode_token';
 try{
  const header=JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0])));
  const claims=JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1])));
  if(header.alg!=='RS256'||typeof header.kid!=='string')return fail('unsupported_access_jwt_header');
  const domain=new URL(env.ACCESS_TEAM_DOMAIN);
  if(domain.protocol!=='https:'||!domain.hostname.endsWith('.cloudflareaccess.com')||domain.pathname!=='/')return fail('invalid_access_team_domain');
  const issuer=domain.origin;
  const now=Math.floor(Date.now()/1000);
  if(claims.iss!==issuer)return fail('access_issuer_mismatch');
  if(!(typeof claims.aud==='string'?claims.aud===env.ACCESS_AUD:Array.isArray(claims.aud)&&claims.aud.includes(env.ACCESS_AUD)))return fail('access_audience_mismatch');
  if(typeof claims.exp!=='number'||claims.exp<=now||typeof claims.iat!=='number'||claims.iat>now+60||
    (typeof claims.nbf==='number'&&claims.nbf>now+60))return fail('access_jwt_time_invalid');
  phase='fetch_certificates';
  const res=await fetch(issuer+'/cdn-cgi/access/certs',{redirect:'error'});
  if(!res.ok)return fail('access_certificates_unavailable');
  phase='parse_certificates';
  const jwks=await res.json();
  phase='select_signing_key';
  const key=jwks.keys?.find(k=>k.kid===header.kid&&k.kty==='RSA');
  if(!key)return fail('access_signing_key_not_found');
  phase='import_signing_key';
  const imported=await crypto.subtle.importKey('jwk',key,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
  phase='verify_signature';
  const verified=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',imported,decodeBase64Url(parts[2]),new TextEncoder().encode(parts[0]+'.'+parts[1]));
  return verified?{ok:true}:fail('access_jwt_signature_invalid');
 }catch{return fail('access_jwt_error_'+phase);}
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
export default { async fetch(req,env){
 try{
  const u=new URL(req.url);if(u.pathname!=='/mcp')return reply({error:'Not found'},404);
  if(!env.MONEYLOVER_EMAIL || !env.MONEYLOVER_PASSWORD)return reply({error:'Integration not configured'},503);
  if(env.ACCESS_TEAM_DOMAIN){
   if(!env.ACCESS_AUD){
    console.warn('moneylover_auth: access_audience_not_configured');
    return reply({error:'Access configuration incomplete'},503);
   }
   const auth=await validAccessJwt(req,env);
   if(!auth.ok){
    console.warn('moneylover_auth: '+auth.reason);
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
   catch(e){return reply(rpcResult(id,{content:[{type:'text',text:'Unable to retrieve data: '+(e.message==='Invalid walletId or dates'||e.message.startsWith('Date range')||e.message==='walletId is required'?e.message:'upstream request failed')}],isError:true}));}
  }
  return reply(rpcError(id,-32601,'Method not found'),404);
 }catch{return reply({error:'Request failed'},500)}
 }};
