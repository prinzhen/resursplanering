#!/usr/bin/env node
/**
 * Säker testsvit för Resursplanering – kör ALDRIG tester mot produktionsdata.
 * Integrationstesterna startar egna tillfälliga D1/SQLite-instanser på localhost
 * och städar bort dem efter avslut. Inga inloggningsuppgifter för drift behövs.
 *
 * Usage:
 *   node scripts/test-release-readiness.mjs
 *   node scripts/test-release-readiness.mjs --quick
 */
import {spawnSync} from "node:child_process";
import {existsSync,writeFileSync} from "node:fs";
import {resolve} from "node:path";

const quick=process.argv.includes("--quick");
if(process.env.TEST_DATA_SOURCE) {
 console.error("STOPP: TEST_DATA_SOURCE får inte vara satt i den samlade testsviten.");
 process.exit(2);
}
const root=resolve(import.meta.dirname,"..");
const mandatory=[
 ["Produktion: granskat releaseskript med Bash-syntax och säkerhetsspärrar", "scripts/test-production-release-safety.mjs"],
 ["Rollmatris: administratör, chef, teamledare, projektledare, medarbetare", "scripts/test-role-access.mjs"],
 ["Veckoimport v2: autentisering, skapande, datum, ändringar och backup", "scripts/test-weekly-v2-integration.mjs"],
 ["Vanlig import/export: XLSX, MSPDI/XML, MPX, CSV-spärr", "scripts/test-planning-exchange.mjs"],
 ["Veckomall v2: person, veckor, XLSX och varaktighet", "scripts/test-weekly-v2.mjs"],
 ["Aktivitet: enradsexport och Gantt-datum", "scripts/test-weekly-single-row.mjs"],
 ["Beläggning och historik", "scripts/test-weekly-load.mjs"],
 ["Effort-historik och överlappande perioder", "scripts/test-effort-history.mjs"],
 ["Historiskt projektansvar per datum", "scripts/test-project-attribution.mjs"],
];
const extended=[
 ["Full integration: importer, databasmigrationer och återställning", "scripts/test-individual-integration.mjs"],
 ["Tidrapportsynk", "scripts/test-tidrapport-sync.mjs"],
 ["Chefsvy och personalavgränsning", "scripts/test-chef-filter.mjs"],
];
const suites=quick?mandatory:[...mandatory,...extended];
const report={when:new Date().toISOString(),quick,source:"disposable local SQLite",results:[]};
let failure=false;
for(const [name,script] of suites) {
 if(!existsSync(resolve(root,script))) {
  console.error("FAIL: Saknat testprogram",script);failure=true;
  report.results.push({name,script,status:"FAIL",exit:2});
  continue;
 }
 console.log("\n================================================");
 console.log("TEST:",name);
 console.log("SCRIPT:",script);
 console.log("================================================");
 const start=Date.now();
 const result=spawnSync(process.execPath,[script],{
  cwd:root,
  env:{...process.env,CI:"true",TEST_DATA_SOURCE:"",NO_COLOR:"1"},
  stdio:"inherit",
  timeout:12*60*1000,
 });
 const status=result.status===0&&!result.error?"PASS":"FAIL";
 const seconds=Math.round((Date.now()-start)/1000);
 report.results.push({name,script,status,seconds,exit:result.status,error:result.error?.message});
 if(status==="FAIL")failure=true;
 console.log(status+": "+name+" ("+seconds+" s)");
}
report.summary={passed:report.results.filter(x=>x.status==="PASS").length,total:report.results.length,failed:report.results.filter(x=>x.status==="FAIL").length};
const file=resolve(root,"test-release-readiness-report.json");
writeFileSync(file,JSON.stringify(report,null,2)+"\n",{mode:0o600});
console.log("\n"+(failure?"FAIL":"SUCCESS")+" RELEASE READINESS: "+report.summary.passed+"/"+report.summary.total+" tester godkända.");
console.log("Testkörningens JSON-rapport:",file);
if(failure)process.exitCode=1;
