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
 for(let at=0;at+30<bytes.length&&bytes.readUInt32LE(at)===0x04034b50;){
  const method=bytes.readUInt16LE(at+8),size=bytes.readUInt32LE(at+18);
  const nameSize=bytes.readUInt16LE(at+26),extra=bytes.readUInt16LE(at+28);
  const name=bytes.toString('utf8',at+30,at+30+nameSize),start=at+30+nameSize+extra;
  const compressed=bytes.subarray(start,start+size);
  assert.ok(method===0||method===8,'Unsupported ZIP method');
  files[name]=(method===8?inflateRawSync(compressed):compressed).toString('utf8');
  at=start+size;
 }
 return files;
}
const temp=mkdtempSync(join(tmpdir(),'weekly-xlsx-recalc-'));
const input=join(temp,'input'),output=join(temp,'output');
mkdirSync(input);mkdirSync(output);
const baseRow={week:'2026-V47',day:'Måndag',task:'Test',duration:'1 vecka',effort:50,
 workType:'Projekt',hours:20,status:'Planerad',priority:'3',deadline:'',projectCode:'P1',
 projectName:'Test',firstWeek:'',comment:'',moveReason:'',activityId:'activity-1'};
const cases=[
 {name:'empty',rows:[],checks:{B6:0,C6:0,C7:0}},
 {name:'full-week',rows:[baseRow],checks:{B6:0,C6:50,C7:20,D6:0}},
 {name:'mixed-duration',rows:[{...baseRow,duration:'1 vecka 3 dagar'}],checks:{C6:50,C7:20,D6:30,D7:12}},
 {name:'hours-only',rows:[{...baseRow,day:'Torsdag',duration:'3 dagar',effort:null,hours:12}],checks:{C6:30,C7:12,D6:0}},
 {name:'weekend',rows:[{...baseRow,day:'Lördag',duration:'2 dagar',effort:null,hours:12}],checks:{C6:0,C7:0,D6:0}},
 {name:'year-boundary',base:'2026-V53',rows:[{...baseRow,week:'2026-V53',day:'Torsdag',duration:'5 dagar',effort:100}],checks:{C6:40,C7:16,D6:20,D7:8}},
 // Change the actual exported cell, retaining its shared formulas.
 {name:'edited-effort',rows:[baseRow],edit:xml=>xml.replace(/(<c r="E5"[^>]*><v>)50(<\/v><\/c>)/,(_match,before,after)=>before+'75'+after),checks:{C6:75,C7:30}},
 {name:'edited-status',rows:[baseRow],edit:xml=>xml.replace('>Planerad<','>Pausad<'),checks:{C6:0,C7:0}},
 {name:'added-last-row',rows:[],edit:xml=>xml.replace('<row r="5004">','<row r="5004">'+
  '<c r="A5004" t="inlineStr"><is><t>v.47</t></is></c>'+
  '<c r="C5004" t="inlineStr"><is><t>Ny aktivitet</t></is></c>'+
  '<c r="D5004" t="inlineStr"><is><t>1 vecka</t></is></c>'+
  '<c r="E5004"><v>25</v></c>'),checks:{C6:25,C7:10,D6:0}},
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
