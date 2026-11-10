import {test,expect} from '@playwright/test';
test('workspace fills browser height and resizes',async({page})=>{
 await page.goto('/');
 for(const height of [720,1080,800]){
  await page.setViewportSize({width:1440,height});
  const boxes=await page.locator('#app').evaluate(el=>({app:el.getBoundingClientRect().toJSON(),children:[...el.children].filter(c=>getComputedStyle(c).display!=='none').map(c=>({id:c.id,box:c.getBoundingClientRect().toJSON()}))}));
  console.log(JSON.stringify(boxes));
  const workspace=boxes.children.find(c=>c.box.height>100);
  expect(workspace).toBeTruthy();
  expect(Math.abs(workspace.box.bottom-height)).toBeLessThanOrEqual(2);
 }
});
