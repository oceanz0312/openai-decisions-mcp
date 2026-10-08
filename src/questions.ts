export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface PredicateQuestion {
  type: "noul";
  instructions: string;
  criteria: { true: string; false: string };
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}

export type DecisionQuestion = ChoiceQuestion | PredicateQuestion | ScoreQuestion;

export function choice(instructions: unknown, criteria: Record<string, string | null>): ChoiceQuestion {
  return {
    type: "choice",
    instructions: typeof instructions === "string" ? instructions : JSON.stringify(instructions),
    criteria,
  };
}

export function noul(
  instructions: string,
  criteria: { true: string; false: string },
): PredicateQuestion {
  return { type: "noul", instructions, criteria };
}

export function score(instructions: string, criteria: string[]): ScoreQuestion {
  return { type: "score", instructions, criteria };
}
