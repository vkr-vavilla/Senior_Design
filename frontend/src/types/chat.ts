export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
}

export interface InterviewConfig {
  role: string;
  type: 'technical' | 'behavioral' | 'mixed';
  difficulty: 'easy' | 'medium' | 'hard';
  modelSource: 'local' | 'api';
  interviewId?: string;
}

export interface ChatChunk {
  chunk: string;
  done: boolean;
  source?: 'local' | 'api';
  is_error?: boolean;
}

// Keyed by rating name. Current set: correctness/depth/clarity/examples/
// resume_knowledge; feedback stored before the SWE-focused axes has
// clarity/depth/structure/examples/confidence/conciseness instead.
export type SkillRatingsMetrics = Record<string, number>;

// Structured scores from the judge + objective stats computed in backend code.
// Absent (or partially absent) for feedback generated before this existed —
// consumers fall back to parsing the markdown report.
export interface FeedbackMetrics {
  overall_score?: number;
  skill_ratings?: SkillRatingsMetrics;
  computed?: {
    questions_answered: number;
    total_answer_words: number;
    avg_answer_words: number;
    coding?: { attempts: number; solved: number; tests_passed: number; tests_total: number };
  };
}

export interface FeedbackResult {
  feedback: string;
  metrics?: FeedbackMetrics | null;
}

// A saved coding-round submission — pushed onto the interview doc by
// POST /coding/submit each time the candidate submits (not just runs) code.
export interface CodingAttempt {
  problem_id: string;
  slug?: string;
  title: string;
  difficulty: string;
  language: string;
  code: string;
  passed: number;
  total: number;
  all_passed: boolean;
  submitted_at: string;
}

export interface Session {
  _id: string;
  role: string;
  interview_type: string;
  difficulty: 'easy' | 'medium' | 'hard';
  messages: { role: string; content: string }[];
  feedback: string | null;
  created_at: string;
  resume_filename?: string;
  job_description?: string;
  coding_attempts?: CodingAttempt[];
}
