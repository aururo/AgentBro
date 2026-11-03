const packageJson = require('./package.json')

module.exports = {
  ...packageJson.build,
  appId: 'io.dsh.desktop.dev',
  productName: 'AgentBro Dev',
  directories: {
    ...packageJson.build.directories,
    output: 'dist-dev'
  },
  extraMetadata: {
    name: 'dsh-desktop-dev',
    productName: 'AgentBro Dev',
    dshDesktopChannel: 'development'
  },
  artifactName: 'agentbro-dev-${os}-${arch}.${ext}',
  nsis: {
    ...packageJson.build.nsis,
    artifactName: 'agentbro-dev-windows-${arch}-setup.${ext}'
  },
  publish: null
}
