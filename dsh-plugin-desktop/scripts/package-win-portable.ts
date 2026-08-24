/** Build an unsigned Windows x64 portable ZIP archive on a native Windows host. */

import { fileURLToPath } from 'node:url'
import {
  createWindowsPackageOptions,
  packageWindowsArtifact,
  runUpstreamInjection,
} from './package-win.ts'

const invokedPath = process.argv[1]
if (invokedPath !== undefined && invokedPath === fileURLToPath(import.meta.url)) {
  try {
    runUpstreamInjection()
    packageWindowsArtifact(
      createWindowsPackageOptions('./verify-win-portable.ts'),
      'zip',
      'portable archive',
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
