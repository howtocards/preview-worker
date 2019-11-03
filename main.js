const path = require("path")
const puppeteer = require("puppeteer")
const amqplib = require("amqplib/callback_api")
const debug = require("debug")("worker")

const RABBIT_HOST = "amqp://localhost:5672" // tls 5671
const RENDER_HOST = "https://howtocards.io"
const cardPath = () =>
  path.resolve(__dirname, `screenshots/${new Date().toISOString()}.png`)

const connect = (url) =>
  new Promise((resolve, reject) => {
    amqplib.connect(url, (err, conn) => {
      if (err) return reject(err)
      return resolve(conn)
    })
  })

const createChannel = (connection) =>
  new Promise((resolve, reject) => {
    connection.createChannel((err, channel) => {
      if (err) return reject(err)
      return resolve(channel)
    })
  })

async function main() {
  debug("worker starting")

  const browser = await puppeteer.launch({
    args: ["--disable-dev-shm-usage", "--no-sandbox"],
  })
  debug("browser started")

  const page = await browser.newPage()
  debug("tab opened")

  await page.setViewport({ deviceScaleFactor: 2, width: 1920, height: 1080 })
  debug("viewport set")

  await page.goto(`${RENDER_HOST}`, { waitUntil: "networkidle0" })
  debug(`opened ${RENDER_HOST}`)

  try {
    const connection = await connect(RABBIT_HOST)
    debug("rabbit connected")

    const channel = await createChannel(connection)
    debug("rabbit channel created")

    channel.consume(
      "event",
      async (message) => {
        const json = JSON.parse(message.content.toString())
        debug("handled event", json)

        try {
          await render(page, json)
          channel.ack(message)
        } catch (error) {
          console.error("failed to render", error, json)
        }
      },
      { noAck: false },
    )

    process.on("SIGINT", async () => {
      debug("caught interrupt signal")

      channel.close()
      debug("rabbit channel closed")

      connection.close()
      debug("rabbit connection closed")

      await browser.close()
      debug("browser killed")

      process.exit()
    })
  } catch (error) {
    console.error(error)
    debug("FAILED start")
    await browser.close()
  }
}

async function render(page, { url, selector, callback }) {
  console.time("screenshot")

  await page.goto(`${RENDER_HOST}${url}`, { waitUntil: "networkidle0" })
  debug(`opened ${RENDER_HOST}${url}`)

  await page.addStyleTag({ content: "header{opacity: 0}" })
  debug("header hidden")

  const el = await page.$(selector)
  debug("article found")

  const { x, y, width } = await el.boundingBox()
  const height = Math.round((width / 16) * 9)
  debug("bounding box", { x, y, width, height })

  await page.screenshot({
    path: cardPath(),
    omitBackground: true,
    clip: { x, y, width, height },
  })
  debug("screenshot taken")

  console.timeEnd("screenshot")
}

main().catch((error) => {
  console.error(error)
  process.exit(-1)
})
