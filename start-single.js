// const { exec } = require("child_process")
const { program } = require('commander')
const { run } = require("./app")

program
  .option('-t, --token <string>', '<token>')

program.parse()

const options = program.opts()

const token = options.token

if (!token) {
  program.help()
}

const USER = {
  token: token,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
}

console.log(`[${token}] Starting with user without proxies...`)

async function main() {
  run(USER)
}

main().catch(console.error)
