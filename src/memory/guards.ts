import type {
  OfficeMemoryOrigin,
  OfficeMemoryRejectionReason,
} from "./types.js"

export type OfficeMemoryEligibility =
  | { eligible: true; reason: null }
  | { eligible: false; reason: OfficeMemoryRejectionReason }

export interface OfficeMemoryEligibilityInput {
  contentText: string
  origin: OfficeMemoryOrigin
  assistantControl: boolean
  botChannel: boolean
  learningEnabled: boolean
}

/**
 * Hard persistence guard for the office corpus. This intentionally lives outside
 * prompts so a model or an imported message cannot relax the boundary.
 */
export function evaluateOfficeMemoryEligibility(
  input: OfficeMemoryEligibilityInput,
): OfficeMemoryEligibility {
  if (input.assistantControl) return { eligible: false, reason: "assistant_control" }
  if (input.origin === "agent") return { eligible: false, reason: "self_generated" }
  if (input.botChannel) return { eligible: false, reason: "bot_channel" }
  if (input.contentText.trim() === "") return { eligible: false, reason: "empty_content" }
  if (!input.learningEnabled) return { eligible: false, reason: "learning_disabled" }
  return { eligible: true, reason: null }
}
