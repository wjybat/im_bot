#!/usr/bin/env node
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const sourceRoot = resolve(process.env.LARK_SKILLS_SOURCE || join(homedir(), ".agents", "skills"))
const skillsRoot = resolve(root, "runtime", "skills")
const targetRoot = resolve(skillsRoot, "integrations", "lark")
const legacyTargetRoot = resolve(skillsRoot, "official")
const legacyManifest = resolve(skillsRoot, "official-manifest.json")

const entries = await readdir(sourceRoot, { withFileTypes: true })
const names = entries
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("lark-"))
  .map((entry) => entry.name)
  .sort()

if (names.length === 0) throw new Error(`no lark-* skills found under ${sourceRoot}`)

await rm(targetRoot, { recursive: true, force: true })
await rm(legacyTargetRoot, { recursive: true, force: true })
await rm(legacyManifest, { force: true })
await mkdir(targetRoot, { recursive: true, mode: 0o755 })
for (const name of names) {
  await cp(join(sourceRoot, name), join(targetRoot, name), {
    recursive: true,
    filter: (path) => !path.endsWith(".DS_Store"),
  })
}
await writeFile(
  resolve(targetRoot, "manifest.json"),
  `${JSON.stringify({ source: "~/.agents/skills", skills: names }, null, 2)}\n`,
  "utf8",
)
process.stdout.write(`synced ${names.length} Lark integration skills\n`)
