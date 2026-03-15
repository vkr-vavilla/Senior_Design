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
  interviewId?: string;
}

export interface ChatChunk {
  chunk: string;
  done: boolean;
}
