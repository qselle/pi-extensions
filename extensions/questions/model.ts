export const MAX_QUESTIONS = 4;
export const MAX_OPTIONS = 8;
export const MAX_ID_CHARS = 64;
export const MAX_QUESTION_CHARS = 2_000;
export const MAX_OPTION_CHARS = 300;
export const MAX_ANSWER_CHARS = 4_000;

export interface QuestionInput {
  id: string;
  question: string;
  options?: string[];
  allow_other?: boolean;
  secret?: boolean;
}

export interface Question {
  id: string;
  question: string;
  options: string[];
  allowOther: boolean;
  secret: boolean;
}

export interface QuestionAnswer {
  id: string;
  question: string;
  answer?: string;
  provided?: boolean;
  cancelled?: boolean;
  secret?: boolean;
  source?: "terminal" | "telegram";
}

export interface QuestionnaireDetails {
  questions: QuestionInput[];
  answers: QuestionAnswer[];
  interrupted: boolean;
}

export function normalizeQuestions(value: unknown): Question[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("questionnaire requires at least one question");
  if (value.length > MAX_QUESTIONS) throw new Error(`questionnaire supports at most ${MAX_QUESTIONS} questions`);

  const ids = new Set<string>();
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`question ${index + 1} must be an object`);
    }
    const input = candidate as Record<string, unknown>;
    const id = requiredText(input.id, `question ${index + 1} id`, MAX_ID_CHARS);
    const question = requiredText(input.question, `question ${index + 1} text`, MAX_QUESTION_CHARS);
    if (ids.has(id)) throw new Error(`question id ${JSON.stringify(id)} is duplicated`);
    ids.add(id);

    const rawOptions = input.options === undefined ? [] : input.options;
    if (!Array.isArray(rawOptions)) throw new Error(`question ${JSON.stringify(id)} options must be an array`);
    if (rawOptions.length > MAX_OPTIONS) throw new Error(`question ${JSON.stringify(id)} supports at most ${MAX_OPTIONS} options`);
    const options = rawOptions.map((option, optionIndex) =>
      requiredText(option, `question ${JSON.stringify(id)} option ${optionIndex + 1}`, MAX_OPTION_CHARS));

    return {
      id,
      question,
      options,
      allowOther: input.allow_other !== false || options.length === 0,
      secret: input.secret === true,
    };
  });
}

export function publicQuestions(questions: Question[]): QuestionInput[] {
  return questions.map((question) => ({
    id: question.id,
    question: question.question,
    ...(question.options.length > 0 ? { options: [...question.options] } : {}),
    ...(question.allowOther ? {} : { allow_other: false }),
    ...(question.secret ? { secret: true } : {}),
  }));
}

export function cleanAnswer(value: string): string | undefined {
  const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (!cleaned) return undefined;
  return cleaned.slice(0, MAX_ANSWER_CHARS);
}

export function parseReplyText(question: Question, value: string): string | "cancel" | undefined {
  const answer = cleanAnswer(value);
  if (!answer) return undefined;
  if (/^\/cancel(?:@\w+)?$/i.test(answer)) return "cancel";

  const numbered = answer.match(/^(\d+)(?:[.)]|\s|$)/);
  if (numbered) {
    const index = Number(numbered[1]) - 1;
    if (index >= 0 && index < question.options.length) return question.options[index];
  }

  const matching = question.options.find((option) => option.localeCompare(answer, undefined, { sensitivity: "accent" }) === 0);
  if (matching) return matching;
  return question.allowOther ? answer : undefined;
}

function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  const text = value.trim();
  if (text.length > max) throw new Error(`${label} must be at most ${max} characters`);
  return text;
}
