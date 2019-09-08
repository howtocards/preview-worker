const puppeteer = require("puppeteer");
const path = require("path");

const CARD = "http://localhost:3000/open/7";
const cardPath = () =>
  path.resolve(__dirname, `screenshots/${new Date().toISOString()}.png`);

async function main() {
  const browser = await puppeteer.launch({
    args: ["--disable-dev-shm-usage", "--no-sandbox"]
  });
  try {
    const page = await browser.newPage();
    await page.goto(CARD, { waitUntil: "networkidle0" });
    await page.setViewport({ deviceScaleFactor: 2, width: 1920, height: 1080 });

    const el = await page.$("article");

    await el.screenshot({
      path: cardPath()
    });
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(-1);
});
