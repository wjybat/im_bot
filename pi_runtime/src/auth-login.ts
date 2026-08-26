#!/usr/bin/env node
import { spawn } from "node:child_process"
import { chmod, mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { loadConfig } from "./config.js"

async function main(): Promise<void> {
  const provider = process.argv[2] || "openai-codex"
  const config = loadConfig()
  const authDir = dirname(config.authFile)
  await mkdir(authDir, { recursive: true, mode: 0o700 })
  const executable = resolve(config.projectRoot, "node_modules", ".bin", "pi-ai")
  const code = await new Promise<number>((resolvePromise, rejectPromise) => {
    const child = spawn(executable, ["login", provider], {
      cwd: authDir,
      env: process.env,
      stdio: "inherit",
    })
    child.once("error", rejectPromise)
    child.once("close", (status) => resolvePromise(status ?? 1))
  })
  if (code !== 0) throw new Error(`Pi model login failed with exit code ${code}`)
  await chmod(config.authFile, 0o600)
  process.stdout.write(`Model credential saved for ${provider}.\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
