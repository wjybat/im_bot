#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig } from "../src/config.mjs"

const label = "com.local.im-data-collection.im-bot"
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const template = resolve(root, "launchd", `${label}.plist.template`)
const targetDir = resolve(process.env.HOME, "Library", "LaunchAgents")
const target = resolve(targetDir, `${label}.plist`)
const domain = `gui/${process.getuid()}`

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8" })
  if (!allowFailure && (result.error || result.status !== 0)) {
    const detail = (result.stderr || result.error?.message || "unknown error").trim()
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`)
  }
  return result
}

function executable(name) {
  const result = run("/usr/bin/which", [name])
  return result.stdout.trim()
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

function render() {
  const config = loadConfig()
  const node = process.execPath || executable("node")
  const larkCli = config.larkCli
  const codexCli = config.codexCli
  const path = Array.from(
    new Set(
      [dirname(node), dirname(larkCli), dirname(codexCli), ...(process.env.PATH || "").split(":"), "/usr/bin", "/bin"].filter(
        Boolean,
      ),
    ),
  ).join(":")
  return readFileSync(template, "utf8")
    .replaceAll("__ROOT__", xml(root))
    .replaceAll("__HOME__", xml(process.env.HOME))
    .replaceAll("__NODE__", xml(node))
    .replaceAll("__LARK_CLI__", xml(larkCli))
    .replaceAll("__CODEX_CLI__", xml(codexCli))
    .replaceAll("__PATH__", xml(path))
}

function waitForUnload() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const current = run("/bin/launchctl", ["print", `${domain}/${label}`], {
      allowFailure: true,
    })
    if (current.status !== 0) return
    run("/bin/sleep", ["0.25"])
  }
  throw new Error(`${label} did not finish unloading within 10 seconds`)
}

function install() {
  if (process.platform !== "darwin") throw new Error("launchd installation is only supported on macOS")
  mkdirSync(resolve(root, "logs"), { recursive: true, mode: 0o700 })
  mkdirSync(resolve(root, "var"), { recursive: true, mode: 0o700 })
  mkdirSync(targetDir, { recursive: true, mode: 0o700 })
  run("/bin/launchctl", ["bootout", `${domain}/${label}`], { allowFailure: true })
  waitForUnload()
  writeFileSync(target, render(), { encoding: "utf8", mode: 0o600 })
  chmodSync(target, 0o600)
  run("/usr/bin/plutil", ["-lint", target])
  run("/bin/launchctl", ["bootstrap", domain, target])
  process.stdout.write(`installed and started ${label}\n`)
}

function uninstall() {
  run("/bin/launchctl", ["bootout", `${domain}/${label}`], { allowFailure: true })
  waitForUnload()
  if (existsSync(target)) unlinkSync(target)
  process.stdout.write(`uninstalled ${label}\n`)
}

function status() {
  const result = run("/bin/launchctl", ["print", `${domain}/${label}`], { allowFailure: true })
  if (result.status !== 0) {
    process.stdout.write(`${label} is not loaded\n`)
    process.exitCode = 1
    return
  }
  const lines = result.stdout
    .split(/\r?\n/)
    .filter((line) => /state =|pid =|last exit code =|program =/.test(line))
  process.stdout.write(`${lines.join("\n")}\n`)
}

const command = process.argv[2]
try {
  if (command === "install") install()
  else if (command === "uninstall") uninstall()
  else if (command === "status") status()
  else throw new Error("usage: node scripts/launchd.mjs <install|uninstall|status>")
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
