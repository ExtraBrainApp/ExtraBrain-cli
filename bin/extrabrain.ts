import { DocumentApiClient } from '../src/apiClient.service'
import { credentialStore } from '../src/credentialStore'
import { ResumeStore } from '../src/resumeStore.service'
import { runCli } from '../src/run.service'

void runCli(process.argv.slice(2), {
  apiFactory: (credential) => new DocumentApiClient(credential),
  credentialStore,
  output: {
    error: (message) => process.stderr.write(`${message}\n`),
    write: (message) => process.stdout.write(`${message}\n`)
  },
  resumeStore: new ResumeStore()
}).then((code) => {
  process.exitCode = code
})
