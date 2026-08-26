#!/usr/bin/env node
import { loadConfig } from "./config.js"
import { JsonCredentialStore } from "./agent/credential-store.js"

async function main(): Promise<void> {
  const provider = process.argv[2] || "dmall-ai"
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  const key = Buffer.concat(chunks).toString("utf8").trim()
  if (!/^sk-[A-Za-z0-9_-]{20,}$/u.test(key)) throw new Error("invalid API key format")
  const config = loadConfig()
  const store = new JsonCredentialStore(config.authFile)
  await store.modify(provider, async () => ({ type: "api_key", key }))
  process.stdout.write(`API key stored securely for ${provider}.\n`)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
