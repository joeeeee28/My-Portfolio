// Verifies every INSERT statement has matching column and value counts.
import fs from 'fs';
import path from 'path';
function walk(d){return fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>{const p=path.join(d,e.name);return e.isDirectory()?walk(p):(p.endsWith('.ts')?[p]:[])})}
let bad=0, checked=0;
for(const f of walk('src').concat(walk('scripts'))){
  const src=fs.readFileSync(f,'utf8');
  const re=/INSERT (?:OR REPLACE )?INTO\s+(\w+)\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/gis;
  let m;
  while((m=re.exec(src))){
    const cols=m[2].split(',').map(s=>s.trim()).filter(Boolean).length;
    const vals=m[3].split(',').map(s=>s.trim()).filter(Boolean).length;
    checked++;
    if(cols!==vals){bad++;console.log(`MISMATCH ${f}: ${m[1]} cols=${cols} values=${vals}`);}
  }
}
console.log(bad?`${bad} mismatch(es) in ${checked} statements`:`✓ all ${checked} INSERT statements have matching column/value counts`);
process.exit(bad?1:0);
