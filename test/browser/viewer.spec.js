import { test, expect } from "@playwright/test";
import {fileURLToPath} from 'node:url';
test('imports a synthetic MoTeC LD file',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/');
 await page.locator('#file-input').setInputFiles(fileURLToPath(new URL('../fixtures/synthetic.ld',import.meta.url)));
 await expect(page.locator('#file-info')).toContainText('3 samples');
 await expect(page.locator('#main')).toContainText('RPM');
 expect(errors).toEqual([]);
});
test('exports the active log as CSV',async({page})=>{
 await page.goto('/');
 await page.locator('#file-input').setInputFiles({name:'example.csv',mimeType:'text/csv',buffer:Buffer.from('Time,RPM\n0,1000\n1,2000\n')});
 await expect(page.locator('#file-info')).toContainText('2 samples');
 const pending=page.waitForEvent('download');await page.locator('#btn-export-csv').click();
 const download=await pending;expect(download.suggestedFilename()).toBe('example-export.csv');
 const stream=await download.createReadStream();let csv='';for await(const chunk of stream)csv+=chunk.toString();
 expect(csv).toContain('Channel : RPM');expect(csv).toContain('00:00:01.000,2000');
});
test('imports a synthetic MLVLG v2 file',async({page})=>{
 await page.goto('/');
 await page.locator('#file-input').setInputFiles(fileURLToPath(new URL('../fixtures/synthetic.mlg',import.meta.url)));
 await expect(page.locator('#file-info')).toContainText('3 samples');
 await expect(page.locator('#main')).toContainText('RPM');
});
test('local features work without an account or subscription',async({page})=>{
 await page.goto('/');
 const files=Array.from({length:4},(_,i)=>({name:`log-${i}.csv`,mimeType:'text/csv',buffer:Buffer.from('Time,RPM,Throttle\n0,1000,0\n1,2000,50\n')}));
 await page.locator('#file-input').setInputFiles(files);
 for(let i=0;i<4;i++)await expect(page.locator('#main')).toContainText(`log-${i}`,{timeout:15000});
 await page.locator('#btn-tools-menu').click();
 await page.locator('#tools-menu [data-action="math"]').click();
 await expect(page.getByText('User Math Channels',{exact:true})).toBeVisible();
 await expect(page.getByText('Sign In',{exact:true})).not.toBeVisible();
});
test("loads CSV offline", async ({ page }) => {
  const errors = [],
    remote = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("https://**", (r) => {
    remote.push(r.request().url());
    return r.abort();
  });
  await page.goto("/");
  await page
    .locator("#file-input")
    .setInputFiles({
      name: "sample.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        "Time,RPM,Throttle\n0,1000,0\n0.1,2000,25\n0.2,3000,50\n0.3,4000,75\n",
      ),
    });
  await expect(page.locator("#file-info")).toContainText("4 samples");
  await expect(page.locator("#file-info")).toContainText("2 channels");
  expect(errors).toEqual([]);
  expect(remote).toEqual([]);
});
test("loads the external Haltech fixture and renders traces", async ({
  page,
}) => {
  test.skip(
    !process.env.HALTECH_TEST_LOG,
    "Set HALTECH_TEST_LOG to a private local fixture",
  );
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.locator("#file-input").setInputFiles(process.env.HALTECH_TEST_LOG);
  await expect(page.locator("#file-info")).toContainText("45,670 samples", {
    timeout: 90000,
  });
  await expect(page.locator("#file-info")).toContainText("46:39.86");
  expect(await page.locator("canvas").count()).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
