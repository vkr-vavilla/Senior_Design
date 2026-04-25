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
}
