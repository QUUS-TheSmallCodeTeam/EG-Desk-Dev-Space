// Operator only. No Desk, invite, Agent or network route calls this entry point.
// Execute the already-reviewed bytes (not a re-open of the checked path); no package downloads.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';
const manifest=JSON.parse(readFileSync(new URL('../miniapps/joint-first-party-release.json',import.meta.url)));
const code=readFileSync(new URL('../miniapps/joint-first-party/bin/egdesk-team-apps.mjs',import.meta.url));
if(manifest.name!=='egdesk-team-apps'||manifest.version!=='1.0.0'||manifest.bin!=='egdesk-team-apps'||createHash('sha256').update(code).digest('hex')!==manifest.entrySha256)throw Error('trusted release does not match; refusing to run');
const argv=process.argv.slice(2);if(argv.length<1||argv.length>2||!path.isAbsolute(argv[0])||(argv[1]!=null&&!/^\d{1,5}$/.test(argv[1])))throw Error('usage: node start-verified-team-apps.mjs ABS_NEW_DESCRIPTOR [PORT]');
const worker=spawn(process.execPath,['--input-type=module','-',...argv],{stdio:['pipe','inherit','inherit'],cwd:'/',env:{PATH:path.dirname(process.execPath),LANG:'C'}});worker.stdin.end(code);for(const sig of ['SIGTERM','SIGINT','SIGHUP'])process.once(sig,()=>worker.kill(sig));worker.on('exit',(n,s)=>{process.exitCode=n??(s?1:0);});
