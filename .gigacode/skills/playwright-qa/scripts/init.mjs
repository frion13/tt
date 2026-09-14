import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const packageRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export function initProject(root) {
  const created=[], preserved=[];
  const save=(name,text)=>{
    const file=path.join(root,name);
    if(fs.existsSync(file)){preserved.push(name);return;}
    fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);created.push(name);
  };
  const routing=fs.readFileSync(path.join(packageRoot,'templates/AGENTS.md'),'utf8');
  const hadAgents=fs.existsSync(path.join(root,'AGENTS.md')) && fs.readFileSync(path.join(root,'AGENTS.md'),'utf8')!==routing;
  if(hadAgents){
    preserved.push('AGENTS.md');
    save('PLAYWRIGHT_QA.md',routing);
  } else save('AGENTS.md',routing);
  save('config/profiles.json','{}\n');
  save('config/sources.json',fs.readFileSync(path.join(packageRoot,'config/sources.json'),'utf8'));
  save('config/registry.json','{}\n');
  save('.env.example','# Fill local .env or CI; actual values must not be committed.\n# Source names are examples; map your own env names in config/sources.json.\n# CASE_PORTAL_BASE_URL=\n# CASE_PORTAL_LOGIN=\n# CASE_PORTAL_PASSWORD=\n# DOCS_PORTAL_BASE_URL=\n# DOCS_PORTAL_LOGIN=\n# DOCS_PORTAL_PASSWORD=\n');
  save('config/playwright-mcp.example.json',fs.readFileSync(path.join(packageRoot,'config/playwright-mcp.example.json'),'utf8'));
  save('.playwright/cli.config.json',JSON.stringify({browser:{contextOptions:{ignoreHTTPSErrors:true}}},null,2)+'\n');
  const configs=['ts','js','mts','mjs','cts','cjs'].map(ext=>`playwright.config.${ext}`);
  const existing=configs.find(file=>fs.existsSync(path.join(root,file)));
  if(existing) preserved.push(existing);
  else save('playwright.config.mjs',`import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir: './e2e', forbidOnly: true, retries: 0,
  reporter: [['playwright-qa-skills/reporter']],
  use: {ignoreHTTPSErrors: true, trace: 'off', video: 'off'},
  projects: [{name: 'chromium', use: {browserName: 'chromium'}}]
});
`);
  const manifest=JSON.parse(fs.readFileSync(path.join(packageRoot,'package.json'),'utf8'));
  // A standalone skill contains the runtime, but not sibling skills or the vendor bundle.
  for(const name of (manifest.qaStandaloneSkill ? [] : ['playwright-qa','playwright-cli'])) {
    const source=path.join(packageRoot,name==='playwright-cli'?'vendor':'skills',name);
    for(const client of ['.gigacode']) {
      const relative=path.join(client,'skills',name), dest=path.join(root,relative);
      if(fs.existsSync(dest)){preserved.push(relative);continue;}
      fs.cpSync(source,dest,{recursive:true});created.push(relative);
    }
  }
  // Only append package-owned exclusions. Existing project rules remain intact.
  const ignore=path.join(root,'.gitignore');
  let content=fs.existsSync(ignore)?fs.readFileSync(ignore,'utf8'):'';
  for(const line of ['node_modules/','.env','.env.*','!.env.example','reports/','test-results/']) {
    if(!content.split(/\r?\n/).includes(line)) content+=(content&&!content.endsWith('\n')?'\n':'')+line+'\n';
  }
  fs.writeFileSync(ignore,content);
  const routingNote=hadAgents ? ' Existing agent instructions preserved: merge the QA routing from PLAYWRIGHT_QA.md (if created) / AGENTS.md into your active client instructions as needed.' : '';
  return {created,preserved, next:(existing ? `Add reporter playwright-qa-skills/reporter and use.ignoreHTTPSErrors=true to ${existing}; existing configuration was preserved.` : 'Fill config/profiles.json and .env, then add a case/spec. No demo cases or credentials were copied.')+routingNote};
}
