import axios from 'axios'
import { promises as fs } from 'fs'
import { v4 as uuidV4 } from 'uuid'
import winston from 'winston'
import { getIpAddress, getProxyAgent, getRandomUserAgent, sleep } from './utils.js'

// Global constants
const DOMAIN_API = {
  SESSION: 'http://18.136.143.169/api/auth/session',
  PING: 'https://nw.nodepay.org/api/network/ping'
}

const PING_INTERVAL = 180 * 1000 // 180 seconds

// Logger configuration function to add an account prefix
function createLogger(accountIdentifier) {
  return winston.createLogger({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.printf(({ timestamp, level, message }) =>
        `${timestamp} | [${accountIdentifier}] ${level}: ${message}`
      )
    ),
    transports: [new winston.transports.Console()]
  })
}

// Connection states
const CONNECTION_STATES = {
  CONNECTED: 1,
  DISCONNECTED: 2,
  NONE_CONNECTION: 3
}

class AccountSession {
  constructor(token, id) {
    this.accountId = id
    this.token = token
    this.browserId = uuidV4()
    this.accountInfo = {}
    this.proxyAuthStatus = false
    this.statusConnect = CONNECTION_STATES.NONE_CONNECTION
    this.retries = 0
    this.lastPingTime = 0
    this.proxies = []
    this.userAgent = getRandomUserAgent()
    this.logger = createLogger(`token:${id}`)
  }

  async init() {
    try {
      await this.getProxies()
      await this.authenticate()
      this.startPingLoop()
    } catch (error) {
      this.logger.error(`Initialization error: ${error.message}`)
    }
  }

  async getProxies() {
    try {
      // First, try to load the account-specific proxy file
      const accountProxyPath = `./proxies/${this.accountId}.txt`
      const proxyData = await fs.readFile(accountProxyPath, 'utf-8').catch(async () => {
        // If account-specific file is not found, fall back to root proxies.txt
        const rootProxyPath = './proxies.txt'
        this.logger.info(`Account-specific proxy file(${accountProxyPath}) not found, trying ${rootProxyPath} instead.`)
        return await fs.readFile(rootProxyPath, 'utf-8')
      })

      this.proxies = proxyData.split('\n').filter(Boolean)

      if (!this.proxies.length) {
        throw new Error('No proxies found in either account-specific or root proxy file')
      }

      this.logger.info(`Loaded ${this.proxies.length} proxies for account token ${this.accountId}.`)
    } catch (error) {
      this.logger.error(`Failed to load proxies: ${error.message}`)
      throw error
    }
  }

  async authenticate() {
    for (const proxy of this.proxies) {
      try {
        if (!this.proxyAuthStatus) {
          this.browserId = uuidV4()
          const ipAddress = await getIpAddress(proxy)
          this.logger.info(`IP address: ${ipAddress}`)

          const response = await this.performRequest(DOMAIN_API.SESSION, {}, proxy)
          if (!response) continue

          if (!response || !response.data || response.data.code < 0) {
            throw new Error('Invalid response')
          }

          if (response.data.code !== 0) {
            this.logger.error(`Failed to authenticate with proxy ${proxy}: ${JSON.stringify(response.data)}, response.data.code is not 0`)
            this.handleLogout(proxy)
            continue
          }

          this.accountInfo = response.data.data
          if (this.accountInfo.uid) {
            this.proxyAuthStatus = true
            this.saveSessionInfo()
            this.logger.info(`Authenticated with proxy ${proxy}`)
          } else {
            this.logger.error(`Failed to authenticate with proxy ${proxy}: ${JSON.stringify(this.accountInfo)}, response.data.data.uid is not found`)
            this.handleLogout(proxy)
            continue
          }
        }
      } catch (error) {
        this.logger.error(`Failed to authenticate with proxy: ${proxy}: ${error.message}`)
      }
    }
  }

  async performRequest(url, data, proxy, maxRetries = 3) {
    const headers = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      'User-Agent': this.userAgent
    }

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        let options = {
          headers
        }

        if (proxy) {
          const agent = await getProxyAgent(proxy)
          this.logger.info(`Using proxy agent...`)
          options.httpAgent = agent
          options.httpsAgent = agent
        }

        const response = await axios.post(url, data, options)
        return response
      } catch (error) {
        this.logger.error(`API call failed to ${url} for proxy ${proxy}: ${error.message}`)
        if (error.response && error.response.status === 403) return null
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000))
      }
    }

    this.logger.error(`API call failed to ${url} after ${maxRetries} attempts for proxy ${proxy}`)
    return null
  }

  startPingLoop() {
    const interval = setInterval(async () => {
      await this.ping()
    }, PING_INTERVAL)

    this.logger.info(`Ping loop started with interval ${PING_INTERVAL}ms`)

    process.on('SIGINT', () => clearInterval(interval))
  }

  async ping() {
    const currentTime = Date.now()

    if (currentTime - this.lastPingTime < PING_INTERVAL) {
      this.logger.info(`Skipping ping for account ${this.accountId} as interval has not elapsed yet`)
      return
    }

    this.lastPingTime = currentTime

    for (const proxy of this.proxies) {
      try {
        const data = {
          id: this.accountInfo.uid,
          browser_id: this.browserId,
          timestamp: Math.floor(currentTime / 1000),
          version: '2.2.7'
        }
        const response = await this.performRequest(DOMAIN_API.PING, data, proxy)
        if (response?.data.code === 0) {
          this.logger.info(`Ping successful for proxy ${proxy}`)
          this.statusConnect = CONNECTION_STATES.CONNECTED
          this.retries = 0
        } else {
          this.logger.error(`Ping failed for proxy ${proxy}`)
          this.handlePingFail(proxy, response?.data)
        }
      } catch (error) {
        this.logger.error(`Ping failed for proxy ${proxy}`)
        this.handlePingFail(proxy, null)
      }
    }
  }

  handlePingFail(proxy, response) {
    this.retries++
    if (response?.code === 403) {
      this.handleLogout(proxy)
    } else if (this.retries >= 2) {
      this.statusConnect = CONNECTION_STATES.DISCONNECTED
    }
  }

  handleLogout(proxy) {
    this.statusConnect = CONNECTION_STATES.NONE_CONNECTION
    this.accountInfo = {}
    this.proxyAuthStatus = false
    this.logger.info(`Logged out and cleared session info for proxy ${proxy}`)
  }

  saveSessionInfo() {
    // Placeholder for saving session info if needed
  }
}

async function loadTokens() {
  try {
    const tokens = await fs.readFile('tokens.txt', 'utf-8')
    return tokens.split('\n').filter(Boolean)
  } catch (error) {
    console.log(`Failed to load tokens: ${error.message}`)
    throw error
  }
}

// Main function
async function main() {
  console.log(`
   _  __        __    ___            ___       __
  / |/ /__  ___/ /__ / _ \\___ ___ __/ _ )___  / /_
 /    / _ \\/ _  / -_) ___/ _ \`/ // / _  / _ \\/ __/
/_/|_/\\___/\\_,_/\\__/_/   \\_,_/\\_, /____/\\___/\\__/
                             /___/
-----------------------------------------------------
|           NodePay bot by @overtrue                 |
|     Telegram: https://t.me/+ntyApQYvrBowZTc1       |
| GitHub: https://github.com/web3bothub/nodepay-bot  |
------------------------------------------------------
`)
  console.log('Starting program...')

  await sleep(3000)

  try {
    const tokens = await loadTokens()
    const sessions = tokens.map(async (token, index) => {
      const session = new AccountSession(token, index + 1)
      await sleep(10000)
      return session.init()
    })

    await Promise.allSettled(sessions)
  } catch (error) {
    console.error(`Program terminated: ${error} `)
  }
}

main().catch(error => {
  console.error(`Fatal error: ${error} `)
})
