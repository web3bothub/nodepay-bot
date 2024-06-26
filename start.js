// const { exec } = require("child_process")
const { program } = require('commander')
const { sleep, getRandomInt, generateRandomString } = require('./utils')
const { run } = require("./app")
const { initUser } = require('./recorder')

program
  .option('-t, --token <string>', '<token>')
  .option('-a --area <string>', '<area>')
  .option('-l --count <proxyCount>', '<proxyCount>')

program.parse()

const options = program.opts()

const token = options.token
const area = options.area
const proxyCount = options.count || 50

if (!token || !area) {
  program.help()
}

const USER = {
  token: token,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
}

const PROXY_TEMPLATE = `http://storm-overtrue_area-${area}_life-120_session-[SID]:1234578@us.stormip.cn:1000`

const PROXIES = []

for (let index = 0; index < proxyCount; index++) {
  PROXIES.push(PROXY_TEMPLATE.replace('[SID]', generateRandomString(10)))
}

console.log(`[${token}] Starting with user with ${proxyCount} proxies in ${area}...`)

async function main() {
  const promises = PROXIES.map(async proxy => {
    await sleep(getRandomInt(1000, 60000))
    console.log(`[${USER.token}] Starting with proxy ${proxy}...`)
    await run(USER, proxy)
  })

  await Promise.all(promises)
}

main().catch(console.error)