/**
 * Research guardrails: policy enforcement for research queries.
 *
 * Mirrors GMS's governance/guardrails.ts pattern but adapted for
 * research operations (subject filtering, result count limits, HITL gating).
 */

/**
 * Default forbidden patterns (case-insensitive) that block research queries.
 * These prevent the system from searching for harmful or inappropriate content.
 */
export const DEFAULT_FORBIDDEN_PATTERNS: readonly string[] = [
  "how to hack",
  "exploit vulnerability",
  "bypass security",
  "create malware",
  "illegal drugs",
  "weapons manufacturing",
  "personal information",
  "doxxing",
];

/** Default maximum search result count before requiring human approval. */
export const DEFAULT_MAX_SEARCH_COUNT = 50;

/** Default threshold for low-confidence summarizations that trigger review. */
export const DEFAULT_MIN_CONFIDENCE = 0.3;

export interface GuardrailOptions {
  /** Patterns (case-insensitive substrings) that block research. Defaults to `DEFAULT_FORBIDDEN_PATTERNS`. */
  forbiddenPatterns?: readonly string[];
}

export interface HumanApprovalOptions {
  /** Maximum number of search results before requiring human approval. Defaults to `DEFAULT_MAX_SEARCH_COUNT`. */
  maxSearchCount?: number;
  /** Minimum confidence score; below this triggers human review. Defaults to `DEFAULT_MIN_CONFIDENCE`. */
  minConfidence?: number;
}

export type GuardrailCheck = { allowed: true } | { allowed: false; reason: string };

/**
 * Policy guardrail: checks a research subject against forbidden patterns.
 * Returns { allowed: false, reason } if the subject violates policy.
 */
export function checkGuardrail(subject: string, options: GuardrailOptions = {}): GuardrailCheck {
  const patterns = options.forbiddenPatterns ?? DEFAULT_FORBIDDEN_PATTERNS;
  const lowerSubject = subject.toLowerCase();
  for (const pattern of patterns) {
    if (lowerSubject.includes(pattern.toLowerCase())) {
      return {
        allowed: false,
        reason: `Research subject violates policy: "${pattern}" detected in "${subject}"`,
      };
    }
  }
  return { allowed: true };
}

/**
 * Determines if a research operation requires human approval.
 * Triggers on high result counts or low confidence scores.
 */
export function requiresHumanApproval(
  resultCount: number,
  confidenceScore?: number,
  options: HumanApprovalOptions = {},
): boolean {
  const maxCount = options.maxSearchCount ?? DEFAULT_MAX_SEARCH_COUNT;
  if (resultCount > maxCount) return true;
  if (confidenceScore !== undefined) {
    const minConf = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    if (confidenceScore < minConf) return true;
  }
  return false;
}

export interface GuardrailResult {
  check: GuardrailCheck;
  needsHumanApproval: boolean;
}

/**
 * Evaluate both policy guardrails and human-approval requirements
 * for a research operation.
 */
export function evaluateGuardrails(
  subject: string,
  resultCount: number,
  guardOpts: GuardrailOptions = {},
  approvalOpts: HumanApprovalOptions = {},
  confidenceScore?: number,
): GuardrailResult {
  const check = checkGuardrail(subject, guardOpts);
  const needsHumanApproval = check.allowed
    ? requiresHumanApproval(resultCount, confidenceScore, approvalOpts)
    : false;
  return { check, needsHumanApproval };
}
