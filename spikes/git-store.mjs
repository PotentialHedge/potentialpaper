// Spike behind DESIGN.md section 4.1: git objects in Postgres vs bare repos on disk.
// Needs `npm i pg` and a throwaway Postgres whose tables it creates:
//   node spikes/git-store.mjs postgres://postgres:x@127.0.0.1:<port>/postgres <empty work dir>
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { execFileSync, execSync } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, mkdtempSync } from 'node:fs';
import pg from 'pg';
const url = process.argv[2], WORK = process.argv[3];
const pool = new pg.Pool({ connectionString: url, max: 8 });
const pct = (a, p) => { const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length*p)].toFixed(2); };
const obj = (type, body) => { const raw = Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]); return { oid: createHash('sha1').update(raw).digest(), type, body }; };
const tree = (es) => { const parts=[]; for (const [name,mode,oid] of es.sort((a,b)=>Buffer.compare(Buffer.from(a[0]+(a[1]==='40000'?'/':'')),Buffer.from(b[0]+(b[1]==='40000'?'/':'')))) ) parts.push(Buffer.from(`${mode} ${name}\0`),oid); return obj('tree',Buffer.concat(parts)); };
const para = i => `Section ${i}. `+ 'The method improves on prior work by reweighting the loss across tasks. '.repeat(10)+'\n\n';
const doc = (p,n) => Array.from({length:12},(_,i)=>para(i)).join('')+`Edit ${n} on ${p}\n`;
const LINKS='{"id":"01J","to":"arxiv:1706.03762","label":"extends","note":"Builds on the attention mechanism"}\n';

await pool.query(`create table refs(paper_id int primary key, head bytea not null);
create table objs(paper_id int, oid bytea, type text not null, body bytea not null, primary key(paper_id,oid));
create table revisions(paper_id int, seq int, oid bytea not null, author text, msg text, at timestamptz default now(), primary key(paper_id,seq));
create table current_pages(paper_id int primary key, author_md text, community_md text, links jsonb, head bytea);
create table graph_links(paper_id int, target text, label text);`);

async function commit(p, n, parent) {
  const au = obj('blob',Buffer.from('# TLDR\nAuthor text\n')), cm = obj('blob',Buffer.from(doc(p,n))), ln = obj('blob',Buffer.from(LINKS));
  const ta = tree([['README.md','100644',au.oid]]), tc = tree([['README.md','100644',cm.oid],['links.jsonl','100644',ln.oid]]);
  const root = tree([['author','40000',ta.oid],['community','40000',tc.oid]]);
  const ts=1790000000+n; const c = obj('commit',Buffer.from(`tree ${root.oid.toString('hex')}\n${parent?`parent ${parent.toString('hex')}\n`:''}author u${n} <u${n}@users.potentialpaper> ${ts} +0000\ncommitter potentialpaper <bot@potentialpaper> ${ts} +0000\n\nedit ${n}\n`));
  const cl = await pool.connect();
  try { await cl.query('begin');
    const os=[au,cm,ln,ta,tc,root,c];
    await cl.query(`insert into objs select $1, * from unnest($2::bytea[],$3::text[],$4::bytea[]) on conflict do nothing`,[p,os.map(o=>o.oid),os.map(o=>o.type),os.map(o=>o.body)]);
    const r = parent ? await cl.query('update refs set head=$2 where paper_id=$1 and head=$3',[p,c.oid,parent]) : await cl.query('insert into refs values($1,$2)',[p,c.oid]);
    if (r.rowCount!==1) throw new Error('cas');
    await cl.query('insert into revisions(paper_id,seq,oid,author,msg) values($1,$2,$3,$4,$5)',[p,n,c.oid,'u'+n,'edit']);
    await cl.query(`insert into current_pages values($1,$2,$3,$4,$5) on conflict(paper_id) do update set author_md=$2,community_md=$3,links=$4,head=$5`,[p,'# TLDR',doc(p,n),LINKS.trim(),c.oid]);
    await cl.query('delete from graph_links where paper_id=$1',[p]); await cl.query(`insert into graph_links values($1,'arxiv:1706.03762','extends')`,[p]);
    await cl.query('commit');
  } catch(e){ await cl.query('rollback'); throw e;} finally { cl.release(); }
  return c.oid;
}
// A. Postgres
const PAGES=500, EDITS=20; const lat=[]; let t0=performance.now();
const heads=new Map();
for (let w=0;w<8;w++) await 0;
let next=0; await Promise.all(Array.from({length:8},async()=>{ while(next<PAGES){ const p=next++; let h=null; for(let n=0;n<EDITS;n++){const t=performance.now(); h=await commit(p,n,h); lat.push(performance.now()-t);} heads.set(p,h);} }));
const total=(performance.now()-t0)/1000;
console.log(`PG write: ${PAGES*EDITS} commits ${total.toFixed(1)}s ${(PAGES*EDITS/total).toFixed(0)}/s p50=${pct(lat,.5)}ms p99=${pct(lat,.99)}ms (8 conns)`);
const size=async t=>(await pool.query(`select pg_total_relation_size('${t}') s`)).rows[0].s;
console.log(`PG size objs: ${(await size('objs')/1e6).toFixed(1)}MB = ${(await size('objs')/PAGES/1024).toFixed(1)}KB/page`);
const rl=[]; for(let i=0;i<2000;i++){const t=performance.now(); await pool.query('select * from current_pages where paper_id=$1',[i%PAGES]); rl.push(performance.now()-t);} console.log(`PG read current page p50=${pct(rl,.5)}ms p99=${pct(rl,.99)}ms`);
const hl=[]; for(let i=0;i<500;i++){const t=performance.now(); await pool.query('select seq,oid,author,msg,at from revisions where paper_id=$1 order by seq desc limit 50',[i%PAGES]); hl.push(performance.now()-t);} console.log(`PG read history p50=${pct(hl,.5)}ms`);
// long page
let h=heads.get(0); const LONG=500; for(let n=EDITS;n<LONG;n++) h=await commit(0,n,h);
// dumb http
let reqs=0;
const srv=http.createServer(async(q,s)=>{ reqs++; const u=new URL(q.url,'http://x'); const m=u.pathname.match(/^\/p\/(\d+)\.git\/(.*)$/); if(!m){s.writeHead(404);return s.end();} const p=+m[1],rest=m[2];
  const head=(await pool.query('select head from refs where paper_id=$1',[p])).rows[0]?.head;
  if(rest==='info/refs'){ s.writeHead(200,{'content-type':'text/plain'}); return s.end(`${head.toString('hex')}\trefs/heads/main\n`);}
  if(rest==='HEAD'){ s.writeHead(200,{'content-type':'text/plain'}); return s.end('ref: refs/heads/main\n');}
  const o=rest.match(/^objects\/([0-9a-f]{2})\/([0-9a-f]{38})$/);
  if(o){ const r=(await pool.query('select type,body from objs where paper_id=$1 and oid=$2',[p,Buffer.from(o[1]+o[2],'hex')])).rows[0]; if(r){ s.writeHead(200,{'content-type':'application/x-git-loose-object'}); return s.end(deflateSync(Buffer.concat([Buffer.from(`${r.type} ${r.body.length}\0`),r.body])));} }
  s.writeHead(404); s.end(); });
await new Promise(r=>srv.listen(0,'127.0.0.1',r)); const port=srv.address().port;
const clone=(p)=>new Promise((res,rej)=>{ const d=mkdtempSync(WORK+'/c-'); reqs=0; const t=performance.now(); import('node:child_process').then(({execFile})=>execFile('git',['clone','-q',`http://127.0.0.1:${port}/p/${p}.git`,d],(e,so,se)=>{ if(e) return rej(new Error(se)); const ms=performance.now()-t; const count=execFileSync('git',['-C',d,'rev-list','--count','HEAD']).toString().trim(); const fsck=execFileSync('git',['-C',d,'fsck','--full','--strict'],{stdio:['ignore','pipe','pipe']}).toString().trim(); const log=execFileSync('git',['-C',d,'log','-1','--format=%an <%ae> %s']).toString().trim(); const files=execFileSync('git',['-C',d,'ls-files']).toString().trim().replace(/\n/g,' '); res({ms,count,reqs,fsck:fsck||'clean',log,files}); })); });
console.log('clone 20-commit', await clone(1)); console.log('clone 500-commit', await clone(0)); srv.close();
await pool.end();
// B. disk
const D=WORK+'/repos'; mkdirSync(D,{recursive:true}); const G=(cwd,args,input)=>execFileSync('git',args,{cwd,input,stdio:['pipe','pipe','ignore'],env:{...process.env,GIT_AUTHOR_NAME:'u',GIT_AUTHOR_EMAIL:'u@x',GIT_COMMITTER_NAME:'b',GIT_COMMITTER_EMAIL:'b@x'}}).toString().trim();
const N=25,lat2=[]; t0=performance.now();
for(let p=0;p<N;p++){ const r=`${D}/${p}.git`; mkdirSync(r); execFileSync('git',['init','-q','--bare','--template=',r]); let par=null;
 for(let n=0;n<EDITS;n++){const t=performance.now();
  const b=f=>G(r,['hash-object','-w','--stdin'],f);
  const ta=G(r,['mktree'],`100644 blob ${b('# TLDR\nAuthor text\n')}\tREADME.md\n`);
  const tc=G(r,['mktree'],`100644 blob ${b(doc(p,n))}\tREADME.md\n100644 blob ${b(LINKS)}\tlinks.jsonl\n`);
  const tr=G(r,['mktree'],`040000 tree ${ta}\tauthor\n040000 tree ${tc}\tcommunity\n`);
  const c=G(r,['commit-tree',tr,...(par?['-p',par]:[]),'-m','edit']); G(r,['update-ref','refs/heads/main',c]); par=c; lat2.push(performance.now()-t);} }
const t2=(performance.now()-t0)/1000;
console.log(`DISK write (git plumbing, serial): ${N*EDITS} commits ${t2.toFixed(1)}s p50=${pct(lat2,.5)}ms p99=${pct(lat2,.99)}ms`);
const du=+execSync(`du -sk ${D}`).toString().split('\t')[0], inodes=+execSync(`find ${D} | wc -l`).toString();
console.log(`DISK size: ${(du/N).toFixed(1)}KB/page, ${(inodes/N).toFixed(0)} inodes/page`);
execFileSync('git',['-C',`${D}/0.git`,'gc','-q']); console.log('DISK after gc page0 KB:', execSync(`du -sk ${D}/0.git`).toString().split('\t')[0], 'inodes', execSync(`find ${D}/0.git | wc -l`).toString().trim());
