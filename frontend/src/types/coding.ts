export interface CodingProblem {
  id: string;
  slug: string;
  title: string;
  difficulty: string;
  topic_tags: string[];
  content_html: string;
  code_snippets: Record<string, string>;
  hints: string[];
}

export interface CaseResult {
  index: number;
  passed: boolean;
  expected: string;
  actual: string;
  runtime_error: boolean;
}

export interface RunResult {
  status: string | null;
  passed: number;
  total: number;
  all_passed: boolean;
  cases: CaseResult[];
  stderr: string;
  compile_output: string;
  time: string | null;
  memory: number | null;
}
