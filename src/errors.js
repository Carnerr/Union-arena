export class GameRuleError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "GameRuleError";
    this.code = code;
    this.details = details;
  }
}

export function assertRule(condition, code, message, details) {
  if (!condition) {
    throw new GameRuleError(code, message, details);
  }
}
