const { exec } = require('child_process')
const { input } = require('@inquirer/prompts')
const { initUser } = require('./recorder')

async function main() {
  const token = await input({ message: 'User token: ' })
  const area = await input({ message: 'Contry code: ' })
  const proxyCount = await input({ message: 'Proxy count: ', default: 50 })
  const appName = await input({ message: 'pm2 app name: ', default: `nodepay-${token}` })

  if (!token || !area) {
    console.log('User ID and area are required')
    process.exit(1)
  }

  initUser(token, appName, proxyCount)

  const command = `pm2 start start.js --name ${appName} --restart-delay=30000 -- --user ${token} --area ${area} --count ${proxyCount}`

  exec(command, (error, stdout) => {
    if (error) {
      console.error(`exec error: ${error}`)
      return
    }

    console.log(`stdout: ${stdout}`)
    console.error(`command: ${command}`)
  })
}

main().catch(console.error)
