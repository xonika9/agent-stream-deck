import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("concurrent T3 setup processes preserve both configuration updates", {
  skip: process.platform !== "darwin",
}, async () => {
  const home = await mkdtemp(join(tmpdir(), "deck-t3-lock-"));
  const helper = new URL("../scripts/t3-config-lock.mjs", import.meta.url).href;
  // The fixture records a refused lock attempt, so the test waits for real contention instead of a fixed delay.
  const code = `import fsp,{readFile,writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {homedir} from 'node:os';
const root=homedir(), id=process.argv[1];
const open=fsp.open;
fsp.open=async(...args)=>{try{return await open(...args)}catch(error){if(error.code==='EEXIST')await writeFile(root+'/contended.'+id,'');throw error}};
syncBuiltinESMExports();
const {withT3ConfigLock}=await import(${JSON.stringify(helper)});
await withT3ConfigLock(async()=>{
 await writeFile(root+'/entered.'+id,'');
 const path=root+'/state.json';
 let saved=[];try{saved=JSON.parse(await readFile(path,'utf8'))}catch{}
 if(id==='first')for(;;){try{await readFile(root+'/release');break}catch{await new Promise(r=>setTimeout(r,10))}}
 await writeFile(path,JSON.stringify([...saved,id]));
});`;
  const children: ReturnType<typeof spawn>[] = [];
  const launch = (id: string) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, id], {
      env: { ...process.env, HOME: home },
      stdio: "ignore",
    });
    children.push(child);
    return new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => (code === 0 ? resolve() : reject(new Error("Fixture process failed"))));
    });
  };
  const waitFor = async (file: string) => {
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        await access(join(home, file));
        return;
      } catch {
        if (Date.now() >= deadline) throw new Error("Fixture startup timed out");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  };
  try {
    const first = launch("first");
    await waitFor("entered.first");
    const second = launch("second");
    await waitFor("contended.second");
    await assert.rejects(access(join(home, "entered.second")), { code: "ENOENT" });
    await writeFile(join(home, "release"), "");
    await Promise.all([first, second]);
    assert.deepEqual(JSON.parse(await readFile(join(home, "state.json"), "utf8")), ["first", "second"]);
  } finally {
    for (const child of children) child.kill();
    await rm(home, { recursive: true, force: true });
  }
});
