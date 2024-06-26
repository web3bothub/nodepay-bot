const WEBSOCKET_URL = "wss://nw.nodepay.ai:4576/websocket"
const RETRY_INTERVAL = 60000
const PING_INTERVAL = 105000
const VERSION = '2.1.9'
const STATUSES = {
  CONNECTED: "CONNECTED",
  DISCONNECTED: "DISCONNECTED",
  DEAD: "DEAD",
  CONNECTING: "CONNECTING",
}

const WebSocket = require('ws')
const uuid = require('uuid')
const fs = require('fs')
const path = require('path')
const { HttpsProxyAgent } = require('https-proxy-agent')
const { sleep, getRandomInt, generateRandomString, getIpAddress } = require('./utils')
const getUnixTimestamp = () => Math.floor(Date.now() / 1000)
const recorder = require('./recorder')
const { default: axios } = require('axios')

function uuidv4() {
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) =>
    (
      c ^
      (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))
    ).toString(16)
  )
}

const callAPIInfo = async (token, userAgent) => {
  console.log(`[INFO] callAPIInfo with token: ${token}`)
  const response = await axios.post("https://sandbox-api.nodepay.ai/api/auth/session", {}, {
    credentials: "include",
    headers: {
      'user-agent': userAgent,
      'Authorization': `Bearer ${token}`,
      'Content-Type': "application/json",
    }
  })

  if (response.status === 200) {
    console.log(`[INFO] callAPIInfo success:`, JSON.stringify(response.data))
    return response.data
  }

  console.error(`[ERROR] callAPIInfo failed:`, response.data)

  return Promise.reject(response)
}

class App {
  constructor(user, proxy, version = '3.3.2') {
    this.proxy = proxy
    this.token = user.token
    this.version = version
    this.retries = 0
    this.browserId = null
    this.websocket = false
    this.userAgent = user.userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
    this.websocketStatus = STATUSES.DISCONNECTED
    this.lastLiveConnectionTimestamp = getUnixTimestamp()
  }

  async initialize() {
    this.browserId ??= uuidv4()

    if (this.proxy) {
      console.info(`[INITIALIZE] request with proxy: ${this.proxy}...`)
    }

    // Get the IP address of the proxy
    let ipAddress = 'unknown'
    try {
      ipAddress = await getIpAddress(this.proxy)
    } catch (error) {
      console.error(`[ERROR] Could not get IP address: ${error}`)
    }

    recorder.setUserIpStatus(this.token, ipAddress, 'active')
    recorder.increaseUserIpRetries(this.token, ipAddress)

    if (this.retries > 2) {
      console.error(`[ERROR] too many retries(${this.retries}), sleeping...`)
      recorder.markAsSleeping(this.token, ipAddress)
      await sleep(getRandomInt(10, 6000))
    }

    let options = {
      headers: { 'user-agent': this.userAgent },
      rejectUnauthorized: false,
      ca: fs.readFileSync(path.join(__dirname, '/ssl/websocket.pem')),
    }

    if (this.proxy) {
      options.agent = new HttpsProxyAgent(this.proxy)
    }

    this.websocket = new WebSocket(WEBSOCKET_URL, options)

    this.websocket.on('open', async function (e) {
      console.log("[OPENED] Websocket Open")
      this.retries = 0
      this.lastLiveConnectionTimestamp = getUnixTimestamp()
      this.websocketStatus = STATUSES.CONNECTED
      recorder.setUserIpStatus(this.token, ipAddress, 'open')
    }.bind(this))

    this.websocket.on('message', async function (message) {
      recorder.setUserIpStatus(this.token, ipAddress, 'active')
      console.log(`[REVEIVED] received message: ${message}`)

      // await sleep(getRandomInt(0, 10))

      // Update last live connection timestamp
      this.lastLiveConnectionTimestamp = getUnixTimestamp()

      try {
        message = JSON.parse(message)
      } catch (e) {
        console.error("[ERROR] Could not parse WebSocket message!", message)
        console.error(e)
        return
      }

      switch (message.action) {
        case 'AUTH':
          callAPIInfo(this.token, this.userAgent).then((res) => {
            if (res.code === 0 && res.data.uid) {
              let dataInfo = {
                user_id: res.data.uid,
                browser_id: this.browserId,
                user_agent: this.userAgent,
                timestamp: Math.floor(Date.now() / 1000),
                device_type: "extension",
                version: VERSION,
                token: this.token,
                origin_action: "AUTH",
              }
              this.sendPing(message.id, dataInfo)
            }
          })
          break
        case 'PONG':
          this.sendPong(message.id)
          setTimeout(() => {
            this.sendPing(message.id)
          }, PING_INTERVAL)
          break
        default:
          console.error(`[ERROR] No RPC action ${message.action}!`)
          break
      }
    }.bind(this))

    this.websocket.on('close', async function (code) {
      // e.g. server process killed or network down
      // event.code is usually 1006 in this case
      console.log(`[CLOSE] Connection died: ${code}`)
      this.websocketStatus = STATUSES.DEAD
      recorder.setUserIpStatus(this.token, ipAddress, 'closed')
      recorder.updateUser(this.token, 'lastError', 'Connection died')
      recorder.increaseUserIpRetries(this.token, ipAddress)

      setTimeout(() => {
        this.initialize()
        this.retries++
      }, RETRY_INTERVAL)
    }.bind(this))

    this.websocket.on('error', function (error) {
      recorder.setUserIpStatus(this.token, ipAddress, 'error')
      recorder.updateUser(this.token, 'lastError', error)
      recorder.increaseUserIpRetries(this.token, ipAddress)
      console.error(`[ERROR] ${error}`)
    }.bind(this))
  }

  async sendPing(guid, options = {}) {
    const PENDING_STATES = [
      0, // CONNECTING
      2, // CLOSING
    ]

    if (this.websocket) {
      if (this.websocket.readyState === 1) {
        this.websocketStatus = STATUSES.CONNECTED
      } else if (this.websocket.readyState === 3) {
        this.websocketStatus = STATUSES.DISCONNECTED
      }
    }

    // Check WebSocket state and make sure it's appropriate
    if (PENDING_STATES.includes(this.websocket?.readyState)) {
      console.log("[WARNING] WebSocket not in appropriate state for liveness check...")
      return
    }

    // Check if timestamp is older than ~15 seconds. If it
    // is the connection is probably dead and we should restart it.
    const current_timestamp = getUnixTimestamp()
    const seconds_since_last_live_message = current_timestamp - this.lastLiveConnectionTimestamp

    if (!this.websocket || seconds_since_last_live_message > 29 || this.websocket.readyState === 3) {
      console.error(
        "[ERROR] WebSocket does not appear to be live! Restarting the WebSocket connection..."
      )

      try {
        console.log(`[CLOSE] tring to close websocket...`)
        this.websocket.close()
      } catch (e) {
        // Do nothing.
      }
      return
    }

    // Send PING message down websocket, this will be
    // replied to with a PONG message form the server
    // which will trigger a function to update the
    // lastLiveConnectionTimestamp variable.

    // If this timestamp gets too old, the WebSocket
    // will be severed and started again.
    const message = JSON.stringify({
      id: guid,
      action: "PING",
      ...options,
    })

    console.log(`[PING] send ping: ${message}`)

    try {
      this.websocket.send(message)
    } catch (error) {
      console.error(`[ERROR] Could not send ping message: ${error}`)
    }
  }

  async sendPong(guid) {
    const message = JSON.stringify({
      id: guid,
      origin_action: "PONG",
    })

    console.log(`[PONG] send pong: ${message}`)

    try {
      this.websocket.send(message)
    } catch (error) {
      console.error(`[ERROR] Could not send pong message: ${error}`)
    }
  }
}

module.exports = {
  run: async function run(user, proxy) {
    const app = new App(user, proxy)

    console.log(`[START] [${user.token}] starting...`)

    await app.initialize().catch(console.error)
  }
}
