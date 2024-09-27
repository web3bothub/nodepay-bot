// const { exec } = require("child_process")
const { program } = require('commander')
const { sleep, getRandomInt, generateRandomString } = require('./utils')
const { run } = require("./app")
const fs = require('fs')
const path = require('path')
const { initUser } = require('./recorder')

program
  .option('-t, --token <string>', '<token>')

program.parse()

const options = program.opts()

const token = options.token

const USER = {
  token: token,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
}

const PROXIES = fs.readFileSync(path.resolve(__dirname, 'proxies.txt'), 'utf-8').split('\n').filter(Boolean)

console.log(`[${token}] Starting ...`)

async function main() {
  const promises = PROXIES.map(async proxy => {
    await sleep(getRandomInt(1000, 60000))
    console.log(`[${USER.token}] Starting with proxy ${proxy}...`)
    await run(USER, proxy)
  })

  await Promise.all(promises)
}

main().catch(console.error)
