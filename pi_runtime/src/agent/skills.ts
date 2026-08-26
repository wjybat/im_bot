import {
  formatSkillInvocation,
  formatSkillsForSystemPrompt,
  loadSkills,
  type AgentTool,
  type Skill,
} from "@earendil-works/pi-agent-core"
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node"
import { Type } from "@earendil-works/pi-ai"
import { readFile, realpath, stat } from "node:fs/promises"
import { isAbsolute, resolve, sep } from "node:path"

export interface RuntimeSkills {
  skills: Skill[]
  catalogPrompt: string
  loadTool: AgentTool
  readFileTool: AgentTool
  diagnostics: string[]
}

export async function loadRuntimeSkills(projectRoot: string, skillsDir: string): Promise<RuntimeSkills> {
  const env = new NodeExecutionEnv({ cwd: projectRoot })
  const loaded = await loadSkills(env, skillsDir)
  const byName = new Map(loaded.skills.map((skill) => [skill.name, skill]))
  const loadSkillParameters = Type.Object({
    name: Type.String({ description: "Exact skill name from available_skills" }),
  })
  const loadTool: AgentTool<typeof loadSkillParameters> = {
    name: "load_skill",
    label: "Load skill",
    description:
      "Load the full instructions for one skill from the runtime catalog. Skills may describe platform integrations, domain expertise, or reusable workflows.",
    parameters: loadSkillParameters,
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const skill = byName.get(params.name)
      if (!skill || skill.disableModelInvocation) throw new Error(`unknown or unavailable skill: ${params.name}`)
      return {
        content: [{ type: "text", text: formatSkillInvocation(skill) }],
        details: { name: skill.name },
      }
    },
  }
  const skillsRoot = await realpath(skillsDir)
  const readFileParameters = Type.Object({
    path: Type.String({ description: "Absolute or skills-root-relative path referenced by a loaded skill" }),
  })
  const readFileTool: AgentTool<typeof readFileParameters> = {
    name: "read_skill_file",
    label: "Read skill resource",
    description:
      "Read an instruction, reference, template, or other text resource referenced by an already-loaded skill. Access is restricted to the runtime skills directory.",
    parameters: readFileParameters,
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const requested = isAbsolute(params.path) ? params.path : resolve(skillsRoot, params.path)
      const canonical = await realpath(requested)
      if (canonical !== skillsRoot && !canonical.startsWith(`${skillsRoot}${sep}`)) {
        throw new Error("skill resource path is outside the runtime skill catalog")
      }
      const info = await stat(canonical)
      if (!info.isFile()) throw new Error("skill reference path is not a file")
      if (info.size > 1_000_000) throw new Error("skill reference file exceeds 1 MB")
      return {
        content: [{ type: "text", text: await readFile(canonical, "utf8") }],
        details: { path: canonical, size: info.size },
      }
    },
  }
  return {
    skills: loaded.skills,
    catalogPrompt: formatSkillsForSystemPrompt(loaded.skills),
    loadTool,
    readFileTool,
    diagnostics: loaded.diagnostics.map((item) => `${item.code}: ${item.path}`),
  }
}
