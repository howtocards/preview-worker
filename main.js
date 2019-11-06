const os = require("os")

const nanoid = require("nanoid")
const puppeteer = require("puppeteer")
const amqplib = require("amqplib/callback_api")
const { EventEmitter } = require("emitting")
const FormData = require("form-data")
const fetch = require("node-fetch").default

const De = require("debug")
const debug = require("debug")("worker")

const RABBIT_HOST = process.env.RABBIT_HOST || "amqp://localhost:5672" // tls 5671
const RENDER_HOST = process.env.RENDER_HOST || "https://howtocards.io"
const UPLOADER_HOST = process.env.UPLOADER_HOST || "http://localhost:4000"
const QUEUE_NAME = process.env.QUEUE_NAME || "howtocards:render"

const POOL_SIZE = process.env.POOL_SIZE
  ? parseInt(process.env.POOL_SIZE, 10)
  : os.cpus().length / 2

const VIEWPORT = { deviceScaleFactor: 2, width: 1920, height: 1080 }

main().catch((error) => {
  console.error(error)
  process.exit(-1)
})

async function main() {
  console.log("worker: iron heating")
  debug("worker starting")

  const browser = await puppeteer.launch({
    args: ["--disable-dev-shm-usage", "--no-sandbox"],
  })
  debug("browser started")

  const pool = new Pool(POOL_SIZE)
  debug("pool created")

  await pool.init(async () => {
    const page = await browser.newPage()
    await page.setViewport(VIEWPORT)
    await page.goto(`${RENDER_HOST}`, { waitUntil: "networkidle0" })
    return page
  })
  debug("pool initialized")

  let timeValues = []

  try {
    const connection = await connect(RABBIT_HOST)
    debug("rabbit connected")

    const channel = await createChannel(connection)
    debug("rabbit channel created")

    console.log("worker: ready to accept tasks")

    let currentInQueue = 0

    channel.consume(
      QUEUE_NAME,
      async (message) => {
        try {
          const json = JSON.parse(message.content.toString())
          debug("handled event", json)

          const { type, ...payload } = json

          if (!checkEvent({ type, payload })) {
            debug("received unknown message type", type)
            channel.ack(message)
            return
          }

          currentInQueue++

          const id = nanoid(5)

          const timeStart = Date.now()
          // console.group(`${id} start ${timeStart}`)

          const result = await pool.process((page) =>
            render({
              page,
              id,
              ...createParams(type, payload),
              injectCSS: "header { opacity: 0 }",
            }),
          )

          const screenshotPath = await upload(result.image)
          const timeEnd = Date.now()
          channel.ack(message)

          const timeDiff = timeEnd - timeStart
          console.log(
            `worker:render ${type}:${id} — ${screenshotPath} in ${timeDiff}ms`,
            `(med ${getMedian(timeDiff)}ms)`,
            `(avg ${Math.floor(getAverage(timeDiff))}ms)`,
            `(queue length ${currentInQueue})`,
          )

          currentInQueue--
        } catch (error) {
          console.error("failed to render", error, message.content)
          channel.ack(message)
          debug("message acked")
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
    debug("FAILED to init connection to rabbit")
    await browser.close()
  }

  function getMedian(diff) {
    timeValues.push(diff)
    if (timeValues.length < 2) {
      return diff
    }
    timeValues.sort((a, b) => a - b)
    const half = Math.floor(timeValues.length / 2)
    if (timeValues.length % 2) {
      return timeValues[half]
    }
    return timeValues[half - 1] + timeValues[half] / 2.0
  }
  function getAverage(diff) {
    timeValues.push(diff)
    return timeValues.reduce((a, b) => a + b) / timeValues.length
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

/**
 * Render page and create screenshot
 * Optionally snapshot html for specified selector
 * @param {object} param0
 * @param {object} param0.page
 * @param {string} param0.id
 * @param {string} param0.url
 * @param {object} param0.screenshot
 * @param {string} param0.screenshot.selector
 * @param {string | null} param0.injectCSS
 * @param {object} param0.snapshot
 * @param {string | null} param0.snapshot.selector
 * @returns {Promise<{ image: Buffer, html?: string }>}
 */
async function render({ page, id, url, screenshot, snapshot, injectCSS }) {
  const debug = De(`worker:${id}`)
  const timeLabel = `worker: screenshot ${id}:${url}`
  // debug(timeLabel)
  console.log(timeLabel)
  console.time(timeLabel)

  await page.goto(`${RENDER_HOST}${url}`, { waitUntil: "networkidle0" })
  debug(`opened ${RENDER_HOST}${url}`)

  if (injectCSS) {
    await page.addStyleTag({ content: injectCSS })
    debug("CSS injected")
  }

  const el = await page.$(screenshot.selector)
  debug("element found")

  const { x, y, width } = await el.boundingBox()
  const height = Math.round((width / 16) * 9)
  debug("bounding box", { x, y, width, height })

  const image = await page.screenshot({
    omitBackground: true,
    type: "png",
    clip: { x, y, width, height },
  })
  debug("screenshot taken")

  console.timeEnd(timeLabel)

  if (snapshot) {
    const selector = snapshot.selector || screenshot.selector
    const html = await page.$eval(selector, (node) => node.outerHTML)
    debug("snapshot taken")
    // debug("snapshot html", html.slice(0, 90))
    return { image, html }
  }

  return { image }
}

async function upload(image) {
  debug("image uploading started")
  const form = new FormData()
  form.append("image", image, { filename: "preview.png" })

  const response = await fetch(`${UPLOADER_HOST}/upload`, {
    method: "POST",
    body: form,
  }).then((r) => r.json())
  debug("image uploaded")

  if (response.status === "ok") {
    return response.files[0].path
  }

  debug("image upload status is not ok")

  throw new Error(response.error)
}

const debPool = De("pool")

class Pool {
  constructor(count) {
    this.events = new EventEmitter()
    this.count = count
    this.pages = []
    this.queue = []

    this.events.on("finished", this.checkNext.bind(this))
  }

  init(creator) {
    debPool("initialize", this.count)
    return Promise.all(Array.from({ length: this.count }, creator)).then(
      (pages) => {
        this.pages = pages
      },
    )
  }

  checkNext() {
    if (this.queue.length) {
      this.runNext()
    }
  }

  runNext() {
    this.run(this.queue.shift())
  }

  async run(task) {
    const page = this.pages.pop()
    let result = null
    try {
      result = await task.fn(page)
    } catch (error) {
      console.error("failed to execute task", task.id, error)
    } finally {
      this.pages.push(page)
      this.events.emit(`resolved:${task.id}`, result)
      this.events.emit("finished", null)
    }
  }

  /**
   * @template T
   * @param {(page) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  process(fn) {
    const id = nanoid(4)
    const deb = De(`pool:process:${id}`)

    this.queue.push({ id, fn })
    deb(`enqueue:${id}`)

    if (this.queue.length <= this.pages.length) {
      this.runNext()
    }

    this.events.once(`resolved:${id}`, () => deb(`resolved:${id}`))
    return this.events.take(`resolved:${id}`)
  }
}

function createParams(type, payload) {
  switch (type) {
    case "user":
      return {
        url: `/@${payload.name}`,
        screenshot: { selector: "header + div > div" },
        snapshot: null,
      }
    case "card":
      return {
        url: `/open/${payload.id}`,
        screenshot: { selector: "article" },
        snapshot: { selector: "article [data-slate-editor]" },
      }
  }
}

function checkEvent({ type, payload }) {
  switch (type) {
    case "user":
      return typeof payload === "object" && typeof payload.name === "string"
    case "card":
      return typeof payload === "object" && typeof payload.id === "string"
  }
  return false
}
