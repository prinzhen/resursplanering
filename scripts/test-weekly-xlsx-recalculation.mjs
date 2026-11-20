// Native spreadsheet-engine regression. Requires LibreOffice/soffice on PATH.
// Uses disposable files only; never reads an application database.
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {inflateRawSync} from 'node:zlib';
import {createWeeklyV2Xlsx} from '../lib/weekly-xlsx-v2.ts';
import {zip} from '../lib/individual-xlsx.ts';

function entries(bytes){
 const files={};
 // LibreOffice can use ZIP data descriptors: sizes in local headers are zero.
 // Read sizes and offsets from the central directory instead.
 let end=bytes.length-22;
 while(end>=Math.max(0,bytes.length-65557)&&bytes.readUInt32LE(end)!==0x06054b50)end--;
 assert.ok(end>=0,'Missing ZIP end record');
 const count=bytes.readUInt16LE(end+10);
 let at=bytes.readUInt32LE(end+16);
 for(let i=0;i<count;i++){
  assert.equal(bytes.readUInt32LE(at),0x02014b50,'Invalid ZIP directory');
  const method=bytes.readUInt16LE(at+10),size=bytes.readUInt32LE(at+20);
  const nameSize=bytes.readUInt16LE(at+28),extra=bytes.readUInt16LE(at+30),comment=bytes.readUInt16LE(at+32);
  const local=bytes.readUInt32LE(at+42),name=bytes.toString('utf8',at+46,at+46+nameSize);
  const start=local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28);
  const compressed=bytes.subarray(start,start+size);
  assert.ok(method===0||method===8,'Unsupported ZIP method');
  files[name]=(method===8?inflateRawSync(compressed):compressed).toString('utf8');
  at+=46+nameSize+extra+comment;
 }
 return files;
}
const temp=mkdtempSync(join(tmpdir(),'weekly-xlsx-recalc-'));
const input=join(temp,'input'),output=join(temp,'output');
mkdirSync(input);mkdirSync(output);
const baseRow={week:'2026-V47',day:'Måndag',task:'Test',duration:'1 vecka',effort:50,
 workType:'Projekt',hours:20,status:'Planerad',priority:'3',deadline:'',projectCode:'P1',
 projectName:'Test',firstWeek:'',comment:'',moveReason:'',activityId:'activity-1'};
// Keep independent scenarios in different weeks of the same workbook. This
// exercises all 5000 helper rows without opening nine identical large templates.
const scenarios=[
 baseRow,
 {...baseRow,week:'2026-V49',duration:'1 vecka 3 dagar'},
 {...baseRow,week:'2026-V51',day:'Torsdag',duration:'3 dagar',effort:null,hours:12},
 {...baseRow,week:'2026-V52',day:'Lördag',duration:'2 dagar',effort:null,hours:12},
 {...baseRow,week:'2026-V53',day:'Torsdag',duration:'5 dagar',effort:100},
];
const cases=[
 {name:'empty',rows:[],checks:{B6:0,C6:0,C7:0}},
 {name:'calendar-and-hours',rows:scenarios,
  checks:{B6:0,C6:50,C7:20,D6:0,E6:50,E7:20,F6:30,F7:12,G6:30,G7:12,H6:0,I6:40,I7:16,J6:20,J7:8}},
 // Edit actual cells in the exported workbook, retaining their shared formulas.
 {name:'edited-and-added',rows:scenarios,edit:xml=>xml
  .replace(/(<c r="E5"[^>]*><v>)50(<\/v><\/c>)/,(_match,before,after)=>before+'75'+after)
  .replace(/(<c r="H6"[^>]*><is><t[^>]*>)Planerad(<\/t><\/is><\/c>)/,'$1Pausad$2')
  .replace('<row r="5004">','<row r="5004">'+
   '<c r="A5004" t="inlineStr"><is><t>v.48</t></is></c>'+
   '<c r="C5004" t="inlineStr"><is><t>Ny aktivitet</t></is></c>'+
   '<c r="D5004" t="inlineStr"><is><t>1 vecka</t></is></c>'+
   '<c r="E5004"><v>25</v></c>'),
  checks:{C6:75,C7:30,D6:25,D7:10,E6:0,F6:0,G6:30,H6:0,I6:40,J6:20}},
];
try{
 for(const test of cases){
  let blob=createWeeklyV2Xlsx(test.rows,test.base||'2026-V47');
  if(test.edit){
   const files=entries(Buffer.from(await blob.arrayBuffer()));
   const key='xl/worksheets/sheet1.xml',original=files[key];
   files[key]=test.edit(original);assert.notEqual(files[key],original,'Fixture edit must take effect');
   blob=zip(files);
  }
  writeFileSync(join(input,test.name+'.xlsx'),Buffer.from(await blob.arrayBuffer()));
 }
 const engine=spawnSync('soffice',['-env:UserInstallation=file://'+join(temp,'profile'),
  '--headless','--convert-to','xlsx','--outdir',output,...cases.map(c=>join(input,c.name+'.xlsx'))],
  {encoding:'utf8',timeout:600_000});
 assert.ifError(engine.error);
 assert.equal(engine.status,0,engine.stdout+'\n'+engine.stderr);
 for(const test of cases){
  const files=entries(readFileSync(join(output,test.name+'.xlsx')));
  for(const [name,xml] of Object.entries(files)){
   if(name.startsWith('xl/worksheets/'))assert.doesNotMatch(xml,/<c\b[^>]*\bt="e"/,test.name+' has formula errors');
  }
  const sheet=files['xl/worksheets/sheet2.xml'];
  for(const [ref,value] of Object.entries(test.checks)){
   const cell=sheet.match(new RegExp('<c\\b[^>]*\\br="'+ref+'"[^>]*>([\\s\\S]*?)</c>'))?.[1];
   assert.ok(cell,'Missing recalculated cell '+ref);
   assert.ok(cell.includes('<f'),'Live formula must survive the round trip: '+ref);
   const actual=Number(cell.match(/<v>([^<]+)<\/v>/)?.[1]);
   assert.ok(Math.abs(actual-value)<1e-8,test.name+' '+ref+': '+actual+' != '+value);
  }
  console.log('PASS native XLSX recalculation: '+test.name);
 }
}finally{rmSync(temp,{recursive:true,force:true});}
