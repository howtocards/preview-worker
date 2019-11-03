const path = require("path")
const nanoid = require("nanoid")
const puppeteer = require("puppeteer")
const amqplib = require("amqplib/callback_api")
const debug = require("debug")("worker")
const { EventEmitter } = require("./emitter")

const RABBIT_HOST = "amqp://localhost:5672" // tls 5671
const RENDER_HOST = "https://howtocards.io"
const cardPath = () =>
  path.resolve(__dirname, `screenshots/${new Date().toISOString()}.png`)

async function main() {
  debug("worker starting")

  const browser = await puppeteer.launch({
    args: ["--disable-dev-shm-usage", "--no-sandbox"],
  })
  debug("browser started")

  const pool = new Pool(4)
  debug("pool created")

  await pool.init(async () => {
    const page = await browser.newPage()
    await page.setViewport({ deviceScaleFactor: 2, width: 1920, height: 1080 })
    await page.goto(`${RENDER_HOST}`, { waitUntil: "networkidle0" })
    return page
  })
  debug("pool initialized")

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

        const id = nanoid()

        try {
          await pool.process((page) => render(page, json, id))
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

function connect(url) {
  return new Promise((resolve, reject) => {
    amqplib.connect(url, (err, conn) => {
      if (err) return reject(err)
      return resolve(conn)
    })
  })
}

function createChannel(connection) {
  return new Promise((resolve, reject) => {
    connection.createChannel((err, channel) => {
      if (err) return reject(err)
      return resolve(channel)
    })
  })
}

async function render(page, { url, selector, callback }, id) {
  const timeLabel = `screenshot ${id}:${url}`
  debug(timeLabel)
  console.time(timeLabel)

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

  console.timeEnd(timeLabel)
}

main().catch((error) => {
  console.error(error)
  process.exit(-1)
})

class Pool {
  constructor(count) {
    this.events = new EventEmitter()
    this.count = count
    this.pages = []
  }

  init(creator) {
    return Promise.all(Array.from({ length: this.count }, creator)).then(
      (pages) => {
        this.pages = pages
      },
    )
  }

  async _run(fn, page) {
    debug("POOL start run", this.pages.length)
    await fn(page)
    this.pages.push(page)
    debug("POOL end run", this.pages.length)
    this.events.emit("released")
  }

  /**
   * @param {(page) => Promise} fn
   * @returns {Promise<void>}
   */
  async process(fn) {
    if (this.pages.length) {
      debug("POOL has pages", this.pages.length)
      await this._run(fn, this.pages.pop())
    } else {
      await this.events.take("released")
      await this.process(fn)
    }
  }
}
