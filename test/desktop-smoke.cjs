const assert = require("node:assert/strict");
const { _electron } = require("@playwright/test");
(async () => {
  const app = await _electron.launch({
    args: ["."],
    env: { ...process.env, OPEN_LOG_VIEWER_TEST: "1" },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState();
    assert.equal(await page.locator("#file-input").count(), 1);
    assert.equal(await page.evaluate(() => typeof window.require), "undefined");
    assert.equal(await page.evaluate(() => typeof window.process), "undefined");
    console.log("PASS: desktop window loads with Node integration disabled.");
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
